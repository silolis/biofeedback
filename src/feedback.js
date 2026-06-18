import { state } from './state.js';
import { computeRsa } from './signal.js';
import { getTicksPerCycle, getInhaleFraction } from './pacer-config.js';

//
// Audio pacer (Web Audio API) — cooldown mode, warm singing-bowl timbre with hall reverb
//
const audio = {
  ctx: null,
  master: null,              // final fader (volume + on/off) — everything sums here
  lowpass: null,             // warm filter on the gong bus
  dryGain: null,
  wetGain: null,
  reverb: null,
  tickBus: null,             // ticks' own mostly-dry/bright bus (keeps the wood tight)
  noiseBuf: null,            // short white-noise buffer reused for the tick impact knock
  active: false,
  enabled: false,
  volume: 0.18,
  chimeVolume: 0.22,
  tickVolume: 0.20,          // metronome ticks (bright bus runs a touch hotter)
  mix: 0.5,                  // gong↔tick balance: 0 = gong only, 1 = ticks only, 0.5 = both full
  freqLow: 196,              // G3 — exhale gong/tick register
  freqHigh: 220,             // A3 — inhale gong/tick register
};

// Single mixer between the two cues. Centre keeps both at full; turning toward an
// end fades the other out — so it reads as one "gong ↔ ticks" balance slider.
function gongTickLevels(mix) {
  return {
    gong: mix <= 0.5 ? 1 : 1 - (mix - 0.5) * 2,
    tick: mix >= 0.5 ? 1 : mix * 2,
  };
}

// Chime partials — slower attack, longer tail, less upper harmonic content.
const chimePartials = [
  { ratio: 1.0,  amp: 1.00, decay: 5.5, attack: 0.18 },   // long swell, deep body
  { ratio: 2.0,  amp: 0.42, decay: 4.0, attack: 0.10 },
  { ratio: 2.76, amp: 0.18, decay: 2.8, attack: 0.07 },   // small gong tang
  { ratio: 3.0,  amp: 0.18, decay: 2.6, attack: 0.06 },
  { ratio: 4.5,  amp: 0.08, decay: 1.6, attack: 0.04 },
];

// Tick partials — a struck-wood "tock". Inharmonic, fast-decaying overtones (like a
// temple block / claves) and a triangle body for odd-harmonic bite. Short tails so it
// reads as a knock, not a chime. The impact noise burst and onset pitch-drop in
// playTick() do the rest of the woody work.
const tickPartials = [
  { ratio: 1.0,  amp: 1.00, decay: 0.16, attack: 0.002, type: 'triangle' },  // body
  { ratio: 2.7,  amp: 0.38, decay: 0.07, attack: 0.001 },                    // inharmonic ring
  { ratio: 5.2,  amp: 0.14, decay: 0.035, attack: 0.001 },                   // high knock
];

function createReverbImpulse(ctx, duration, decay) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * duration);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    // 20 ms pre-attack silence for clearer dry/wet separation
    const preDelay = Math.floor(sr * 0.02);
    for (let i = 0; i < len; i++) {
      if (i < preDelay) { data[i] = 0; continue; }
      // Pink-ish noise approximation: low-passed white via simple averaging
      const noise = (Math.random() * 2 - 1);
      const env = Math.pow(1 - (i - preDelay) / (len - preDelay), decay);
      data[i] = noise * env;
    }
  }
  return buf;
}

async function ensureAudio() {
  if (audio.ctx) return;
  audio.ctx = new (window.AudioContext || window.webkitAudioContext)();

  // Final fader: volume + on/off envelope. Both buses sum here, then out.
  audio.master = audio.ctx.createGain();
  audio.master.gain.value = 0;
  audio.master.connect(audio.ctx.destination);

  // Algorithmic hall reverb via convolution with synthesized IR (shared).
  audio.reverb = audio.ctx.createConvolver();
  audio.reverb.buffer = createReverbImpulse(audio.ctx, 4.2, 2.8);
  audio.wetGain = audio.ctx.createGain();
  audio.wetGain.gain.value = 0.55;   // generous wet mix — what de-synthesizes the gong
  audio.reverb.connect(audio.wetGain);
  audio.wetGain.connect(audio.master);

  // Gong bus — warm low-pass into the hall, kept lush.
  audio.lowpass = audio.ctx.createBiquadFilter();
  audio.lowpass.type = 'lowpass';
  audio.lowpass.frequency.value = 1500;   // pulls upper harmonics down for a soft body
  audio.lowpass.Q.value = 0.5;
  audio.dryGain = audio.ctx.createGain();
  audio.dryGain.gain.value = 0.55;
  audio.lowpass.connect(audio.dryGain);
  audio.lowpass.connect(audio.reverb);
  audio.dryGain.connect(audio.master);

  // Tick bus — mostly dry and full-band so the wooden knock stays tight and present
  // (the gong's lowpass + lush reverb would smear it). Only a light room send.
  audio.tickBus = audio.ctx.createGain();
  audio.tickBus.connect(audio.master);             // dry path
  const tickSend = audio.ctx.createGain();
  tickSend.gain.value = 0.12;                       // subtle room around the tick
  audio.tickBus.connect(tickSend);
  tickSend.connect(audio.reverb);

  // Short white-noise buffer reused for each tick's impact transient.
  const nlen = Math.floor(audio.ctx.sampleRate * 0.08);
  audio.noiseBuf = audio.ctx.createBuffer(1, nlen, audio.ctx.sampleRate);
  const nd = audio.noiseBuf.getChannelData(0);
  for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
}

async function startAudioPacer() {
  await ensureAudio();
  if (audio.ctx.state === 'suspended') await audio.ctx.resume();
  const now = audio.ctx.currentTime;
  audio.master.gain.cancelScheduledValues(now);
  audio.master.gain.setValueAtTime(audio.master.gain.value, now);
  audio.master.gain.linearRampToValueAtTime(audio.volume, now + 2.2);
  audio.active = true;
}

function stopAudioPacer() {
  if (!audio.ctx || !audio.active) return;
  const now = audio.ctx.currentTime;
  audio.master.gain.cancelScheduledValues(now);
  audio.master.gain.setValueAtTime(audio.master.gain.value, now);
  audio.master.gain.linearRampToValueAtTime(0, now + 1.4);
  audio.active = false;
}

function playChime(fundamental, gainScale = 1.0) {
  if (!audio.active || !audio.ctx) return;
  const level = audio.chimeVolume * audio.volume * 7 * gainScale * gongTickLevels(audio.mix).gong;
  if (level <= 0) return;                      // gong faded out by the mixer
  const ctx = audio.ctx;
  const t = ctx.currentTime;

  for (const p of chimePartials) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = fundamental * p.ratio;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.setTargetAtTime(level * p.amp, t, p.attack / 3);
    g.gain.setTargetAtTime(level * p.amp, t + p.attack * 0.9, 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + p.attack + p.decay);
    osc.connect(g);
    g.connect(audio.lowpass);                  // gong → warm bus
    osc.start(t);
    osc.stop(t + p.attack + p.decay + 0.3);
  }
}

// A short struck-wood "tock" — the metronome subdivision within a phase.
function playTick(fundamental, gainScale = 1.0) {
  if (!audio.active || !audio.ctx) return;
  const level = audio.tickVolume * audio.volume * 7 * gainScale * gongTickLevels(audio.mix).tick;
  if (level <= 0) return;                      // ticks faded out by the mixer
  const ctx = audio.ctx;
  const t = ctx.currentTime;

  // Pitched body — inharmonic, fast-decaying, with a quick downward pitch blip at the
  // onset that gives wood its characteristic "tock" rather than a flat beep.
  for (const p of tickPartials) {
    const osc = ctx.createOscillator();
    osc.type = p.type || 'sine';
    const f = fundamental * p.ratio;
    osc.frequency.setValueAtTime(f * 1.5, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.016);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(level * p.amp, 0.0002), t + p.attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + p.attack + p.decay);
    osc.connect(g);
    g.connect(audio.tickBus);
    osc.start(t);
    osc.stop(t + p.attack + p.decay + 0.1);
  }

  // Impact transient — a band-passed noise burst is the actual "knock" of wood.
  const nb = ctx.createBufferSource();
  nb.buffer = audio.noiseBuf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = fundamental * 2.5;
  bp.Q.value = 1.1;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(Math.max(level * 0.6, 0.0002), t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
  nb.connect(bp);
  bp.connect(ng);
  ng.connect(audio.tickBus);
  nb.start(t);
  nb.stop(t + 0.06);
}

// One gong per phase. Inhale gets the higher pitch (freqHigh), exhale the slightly
// lower one (freqLow). Each lands on the phase's first metronome tick.
function playInhaleGong() { playChime(audio.freqHigh * 2, 1.0);  }
function playExhaleGong() { playChime(audio.freqLow  * 2, 0.9);  }

// Ticks sit in the same register as their phase's gong so each phase keeps a
// consistent pitch identity and the ticks cut clearly through the mix.
function playInhaleTick() { playTick(audio.freqHigh * 2, 1.0);  }
function playExhaleTick() { playTick(audio.freqLow  * 2, 1.0);  }

//
// Breathing pacer
//
const circle = document.getElementById('pacer-circle');
const label = document.getElementById('pacer-label');

function pacerLoop() {
  if (!state.running) return;
  const brpm = parseFloat(document.getElementById('brpm').value);
  const inhaleFrac = getInhaleFraction();
  const ticksPerCycle = getTicksPerCycle();
  const cycleMs = 60_000 / brpm;

  // Continuous breath phase in [0,1): advance by (elapsed time / cycleMs) each frame.
  // Driving the cue off an accumulated phase — rather than absolute time % cycleMs —
  // means a brpm change mid-breath (e.g. when the sweep steps to the next rate) only
  // changes how fast the phase advances; the circle continues smoothly, never jumps.
  const now = performance.now();
  if (state.lastFrameT === null) state.lastFrameT = now;
  let bp = state.breathPhase + (now - state.lastFrameT) / cycleMs;
  state.lastFrameT = now;
  const wrapped = bp >= 1;
  if (wrapped) bp -= Math.floor(bp);
  state.breathPhase = bp;

  let phase, frac, isInhale;
  if (bp < inhaleFrac) {
    isInhale = true;
    frac = bp / inhaleFrac;
    phase = 'INHALE';
  } else {
    isInhale = false;
    frac = (bp - inhaleFrac) / (1 - inhaleFrac);
    phase = 'EXHALE';
  }

  // Cycle boundary — phase wrapped past 1.0: log amplitude and fire the inhale gong
  if (wrapped) {
    // Store the full-precision fitted amplitude in ms — never round before storing.
    // (Rounding/truncation happens only at display time.)
    const rsa = computeRsa(cycleMs);
    if (rsa != null) {
      const amp = rsa.ms;
      state.sessionAmps.push(amp);
      // Resonance search sample collection — only during 'measuring' phase
      if (state.search.status === 'running' && state.search.currentPhase === 'measuring') {
        const cur = state.search.samples[state.search.currentStepIdx];
        if (cur) cur.cycleAmplitudes.push(amp);
      }
      // Single-setting recording
      if (state.recording.active) {
        const amps = state.recording.sample.cycleAmplitudes;
        amps.push(amp);
        document.getElementById('record').title = `Stop recording (${amps.length} cycles)`;
      }
    }
    if (audio.active) playInhaleGong();
  }

  // Inhale → exhale transition — fire the exhale gong (lower pitch)
  if (state.lastIsInhale === true && isInhale === false) {
    if (audio.active) playExhaleGong();
  }
  state.lastIsInhale = isInhale;

  // Metronome ticks — ticksPerCycle evenly spaced across the cycle. Fire one each
  // time the phase crosses into a new tick slot; the slot at the start of each phase
  // coincides with that phase's gong (split is locked to integer-tick values).
  const slot = Math.floor(bp * ticksPerCycle);
  if (slot !== state.lastTickSlot) {
    if (audio.active) (isInhale ? playInhaleTick : playExhaleTick)();
    state.lastTickSlot = slot;
  }

  // radius from 40 to 140 with sinusoidal easing
  const eased = (1 - Math.cos(Math.PI * frac)) / 2; // 0→1 with smooth ends
  const r = isInhale
    ? 40 + 100 * eased
    : 140 - 100 * eased;
  circle.setAttribute('r', r.toFixed(1));
  circle.style.fill = isInhale ? 'var(--inhale)' : 'var(--exhale)';
  label.textContent = phase;

  // Ambient breath wash (practice/breather modes): intensity tracks how full the breath
  // is (0 at min exhale → 1 at peak inhale), hue follows the phase. CSS reads these vars.
  const fullness = (r - 40) / 100;
  document.body.style.setProperty('--breath-fullness', fullness.toFixed(3));
  document.body.style.setProperty('--breath-color', isInhale ? 'var(--inhale)' : 'var(--exhale)');

  // total session timer
  const totalS = Math.floor((performance.now() - state.sessionStart) / 1000);
  const m = Math.floor(totalS / 60), s = totalS % 60;
  document.getElementById('elapsed').textContent = `${m}:${s.toString().padStart(2,'0')}`;

  requestAnimationFrame(pacerLoop);
}

export { audio, startAudioPacer, stopAudioPacer, pacerLoop, circle, label, gongTickLevels };
