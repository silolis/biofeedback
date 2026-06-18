import { state } from './state.js';
import { computeRsa } from './signal.js';

//
// Audio pacer (Web Audio API) — cooldown mode, warm singing-bowl timbre with hall reverb
//
const audio = {
  ctx: null,
  oscs: [],
  master: null,              // volume control point
  breathGain: null,          // drone-only amplitude modulator, follows breath
  lowpass: null,
  dryGain: null,
  wetGain: null,
  reverb: null,
  lfo: null,
  lfoGain: null,
  active: false,
  enabled: false,
  volume: 0.18,
  chimeVolume: 0.22,
  tickVolume: 0.10,          // metronome ticks — softer than the gong downbeat
  droneLevel: 0.5,           // 0–1 mix scalar for the drone
  chimeLevel: 1.0,           // 0–1 mix scalar for the chimes
  freqLow: 196,              // G3 — fixed drone pitch (breath cue is amplitude, not pitch)
  freqHigh: 220,             // A3 — used only for the higher inhale gong/tick
};

// Metronome subdivisions per full breath cycle. With the inhale/exhale split locked
// to integer-tick values (see index.html), inhaleFrac * TICKS_PER_CYCLE is an integer:
// 0.4 → 4 ticks inhale / 6 exhale, 0.5 → 5 / 5. The first tick of each phase lands on
// the same frame as that phase's gong, so the downbeat reads as gong + tick together.
const TICKS_PER_CYCLE = 10;

// Drone partials — warm balance: fundamental dominant, gentle harmonics, light inharmonic touch.
// Detuning creates slow "wah" beats characteristic of bowed metal.
const dronePartials = [
  { ratio: 1.0,  amp: 1.00, detune: 0  },
  { ratio: 2.0,  amp: 0.30, detune: 3  },
  { ratio: 3.0,  amp: 0.10, detune: -4 },
  { ratio: 2.76, amp: 0.08, detune: 5  },   // inharmonic — kept low for warm character
  { ratio: 4.0,  amp: 0.04, detune: -2 },
];

// Chime partials — slower attack, longer tail, less upper harmonic content.
const chimePartials = [
  { ratio: 1.0,  amp: 1.00, decay: 5.5, attack: 0.18 },   // long swell, deep body
  { ratio: 2.0,  amp: 0.42, decay: 4.0, attack: 0.10 },
  { ratio: 2.76, amp: 0.18, decay: 2.8, attack: 0.07 },   // small gong tang
  { ratio: 3.0,  amp: 0.18, decay: 2.6, attack: 0.06 },
  { ratio: 4.5,  amp: 0.08, decay: 1.6, attack: 0.04 },
];

// Tick partials — short, pitched and woody (a "sonorous metronome", not a dry click).
// Quick attack, short tail, a touch of inharmonic 2nd partial for a wooden knock.
const tickPartials = [
  { ratio: 1.0,  amp: 1.00, decay: 0.22, attack: 0.004 },
  { ratio: 2.01, amp: 0.30, decay: 0.11, attack: 0.003 },   // slight inharmonicity → woody
  { ratio: 3.0,  amp: 0.10, decay: 0.06, attack: 0.002 },
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

  audio.master = audio.ctx.createGain();
  audio.master.gain.value = 0;

  // Drone-only modulator: swells during inhale, eases during exhale.
  // Chimes bypass this so they stay punchy regardless of breath phase.
  audio.breathGain = audio.ctx.createGain();
  audio.breathGain.gain.value = DRONE_LOUDNESS_SCALE * 0.6;   // start at exhale-bottom level
  audio.breathGain.connect(audio.master);

  // Warm low-pass — pulls upper harmonics well down for a softer, less metallic body.
  audio.lowpass = audio.ctx.createBiquadFilter();
  audio.lowpass.type = 'lowpass';
  audio.lowpass.frequency.value = 1500;
  audio.lowpass.Q.value = 0.5;

  // Algorithmic hall reverb via convolution with synthesized IR.
  audio.reverb = audio.ctx.createConvolver();
  audio.reverb.buffer = createReverbImpulse(audio.ctx, 4.2, 2.8);

  audio.dryGain = audio.ctx.createGain();
  audio.wetGain = audio.ctx.createGain();
  audio.dryGain.gain.value = 0.55;
  audio.wetGain.gain.value = 0.55;   // generous wet mix — what de-synthesizes the sound

  audio.master.connect(audio.lowpass);
  audio.lowpass.connect(audio.dryGain);
  audio.lowpass.connect(audio.reverb);
  audio.reverb.connect(audio.wetGain);
  audio.dryGain.connect(audio.ctx.destination);
  audio.wetGain.connect(audio.ctx.destination);

  // Slow LFO modulates master gain — adds organic swell (~±5%, ~8s period).
  audio.lfo = audio.ctx.createOscillator();
  audio.lfo.frequency.value = 0.12;
  audio.lfoGain = audio.ctx.createGain();
  audio.lfoGain.gain.value = 0;             // off until pacer starts
  audio.lfo.connect(audio.lfoGain);
  audio.lfoGain.connect(audio.master.gain);
  audio.lfo.start();

  for (const p of dronePartials) {
    const osc = audio.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = audio.freqLow * p.ratio;
    osc.detune.value = p.detune;
    const g = audio.ctx.createGain();
    g.gain.value = p.amp;
    osc.connect(g);
    g.connect(audio.breathGain);   // drone path runs through breathGain
    osc.start();
    audio.oscs.push({ osc, ratio: p.ratio });
  }
}

const DRONE_LOUDNESS_SCALE = 0.55;

async function startAudioPacer() {
  await ensureAudio();
  if (audio.ctx.state === 'suspended') await audio.ctx.resume();
  const now = audio.ctx.currentTime;
  audio.master.gain.cancelScheduledValues(now);
  audio.master.gain.setValueAtTime(audio.master.gain.value, now);
  audio.master.gain.linearRampToValueAtTime(audio.volume, now + 2.2);
  audio.lfoGain.gain.setTargetAtTime(0.012, now + 0.5, 0.6);
  audio.active = true;
}

function stopAudioPacer() {
  if (!audio.ctx || !audio.active) return;
  const now = audio.ctx.currentTime;
  audio.master.gain.cancelScheduledValues(now);
  audio.master.gain.setValueAtTime(audio.master.gain.value, now);
  audio.master.gain.linearRampToValueAtTime(0, now + 1.4);
  audio.lfoGain.gain.setTargetAtTime(0, now, 0.25);            // fade LFO out cleanly
  audio.active = false;
}

function updateAudioBreath(isInhale, frac) {
  if (!audio.active || !audio.ctx) return;
  const eased = (1 - Math.cos(Math.PI * frac)) / 2;

  // The drone holds a fixed pitch — the breath is carried entirely by the amplitude
  // swell below (and the gongs/ticks). The old pitch glide read as a "siren" and added
  // nothing, so it was removed.
  // Drone amplitude swell — 60% at exhale-bottom, 100% at inhale-top.
  // audio.droneLevel applies the user's drone-vs-gong mix scalar.
  const breathLevel = isInhale ? 0.6 + 0.4 * eased : 1.0 - 0.4 * eased;
  audio.breathGain.gain.setTargetAtTime(
    DRONE_LOUDNESS_SCALE * breathLevel * audio.droneLevel,
    audio.ctx.currentTime, 0.18
  );
}

function playChime(fundamental, gainScale = 1.0) {
  if (!audio.active || !audio.ctx) return;
  if (audio.chimeLevel <= 0) return;          // user has gong silenced
  const ctx = audio.ctx;
  const t = ctx.currentTime;
  const master = audio.chimeVolume * audio.volume * 7 * gainScale * audio.chimeLevel;

  for (const p of chimePartials) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = fundamental * p.ratio;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.setTargetAtTime(master * p.amp, t, p.attack / 3);
    g.gain.setTargetAtTime(master * p.amp, t + p.attack * 0.9, 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + p.attack + p.decay);
    osc.connect(g);
    g.connect(audio.master);        // chimes go to master (bypass breathGain — stay punchy)
    osc.start(t);
    osc.stop(t + p.attack + p.decay + 0.3);
  }
}

// A short pitched percussion hit — the metronome subdivision within a phase.
function playTick(fundamental, gainScale = 1.0) {
  if (!audio.active || !audio.ctx) return;
  if (audio.chimeLevel <= 0) return;          // ticks ride the same gong mix scalar
  const ctx = audio.ctx;
  const t = ctx.currentTime;
  const master = audio.tickVolume * audio.volume * 7 * gainScale * audio.chimeLevel;

  for (const p of tickPartials) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = fundamental * p.ratio;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(master * p.amp, 0.0002), t + p.attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + p.attack + p.decay);
    osc.connect(g);
    g.connect(audio.master);        // ticks go to master (bypass breathGain — stay punchy)
    osc.start(t);
    osc.stop(t + p.attack + p.decay + 0.1);
  }
}

// One gong per phase, an octave above the drone. Inhale gets the higher pitch (freqHigh),
// exhale the slightly lower one (freqLow). Each lands on the phase's first metronome tick.
function playInhaleGong() { playChime(audio.freqHigh * 2, 1.0);  }
function playExhaleGong() { playChime(audio.freqLow  * 2, 0.9);  }

// Tick pitch follows its phase's gong (one octave down = the drone register),
// so each phase keeps a consistent pitch identity.
function playInhaleTick() { playTick(audio.freqHigh, 1.0);  }
function playExhaleTick() { playTick(audio.freqLow,  1.0);  }

//
// Breathing pacer
//
const circle = document.getElementById('pacer-circle');
const label = document.getElementById('pacer-label');

function pacerLoop() {
  if (!state.running) return;
  const brpm = parseFloat(document.getElementById('brpm').value);
  const inhaleFrac = parseFloat(document.getElementById('inhale-frac').value);
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

  // Cycle boundary — phase wrapped past 1.0: log amplitude and fire BOTTOM chime
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

  // Metronome ticks — TICKS_PER_CYCLE evenly spaced across the cycle. Fire one each
  // time the phase crosses into a new tick slot; the slot at the start of each phase
  // coincides with that phase's gong (split is locked to integer-tick values).
  const slot = Math.floor(bp * TICKS_PER_CYCLE);
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
  updateAudioBreath(isInhale, frac);

  // total session timer
  const totalS = Math.floor((performance.now() - state.sessionStart) / 1000);
  const m = Math.floor(totalS / 60), s = totalS % 60;
  document.getElementById('elapsed').textContent = `${m}:${s.toString().padStart(2,'0')}`;

  requestAnimationFrame(pacerLoop);
}

export { audio, startAudioPacer, stopAudioPacer, pacerLoop, circle, label };
