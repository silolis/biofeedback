import {
  solveLinear,
  rejectArtifacts,
  fitSinusoidComponent,
  ampFitWindow,
  envFitWindow,
  tileFit,
  FILTERS,
  filterMinSamples,
  filterMinSpanSec,
  signalSpanSec,
  runPipeline,
  fitSinusoidPoly,
  fitPeakToTrough,
  fitR2,
  fitModel,
} from './estimators-core.mjs';

//
// State
//
const state = {
  rrLog: [],          // {t, rr}  — rr in ms
  hrLog: [],          // {t, hr}  — hr in bpm
  sessionStart: null,
  running: false,
  hrChar: null,
  device: null,
  demoActive: false,
  demoBaseline: 60,
  demoRsaAmp: 4.0,
  demoResonanceFreq: 5.5,   // simulated "true" resonance frequency for demo mode
  demoResonanceWidth: 0.7,  // bandwidth in brpm — narrower = sharper peak
  demoBeatTimer: null,
  breathPhase: 0,      // continuous breath phase [0,1) — keeps the cue smooth across brpm changes
  lastFrameT: null,    // timestamp of previous pacer frame, for phase advance
  lastIsInhale: null,
  sessionAmps: [],    // per-cycle amplitudes for end-of-session summary
  recording: { active: false },   // single-setting recording (sweep JSON format, one sample)
  wakeLock: null,     // Screen Wake Lock sentinel — held while a session runs to block screensaver/sleep
  search: {
    config: {
      rates: [7.0, 6.5, 6.0, 5.5, 5.0, 4.5],   // high → low
      settleSeconds: 30,
      measureSeconds: 60,
    },
    startedAt: null,
    samples: [],
    status: 'idle',                  // idle | running | done | cancelled
    currentStepIdx: -1,
    currentPhase: null,              // 'settling' | 'measuring'
    phaseStartedAt: null,
    phaseTimer: null,
    uiInterval: null,
    previousBrpm: null,
    audioWasEnabled: false,
    result: null,
    results: [],                                   // per-analyzer results (composable searches)
    analyzers: ['vertex-peak', 'argmax'],          // which searches run; vertex-peak is primary
    autoRemaining: 0,                              // auto-refine rounds left in this program
    continuing: false,                             // next startSearch continues the program (keep pool + counter)
    pool: [],                                      // completed samples accumulated across all stages of a program
    programStartedAt: null,
  },
  // Signal filter pipeline. Measurement stages (dedup, reject) clean the beats and feed the score;
  // analysis stages (amp-fit, mayer, fit-envelope) are visualization-only overlays and never touch
  // the metric. dedup runs first (collapse notification echoes), then artifact rejection.
  pipeline: [
    { filterId: 'dedup',            enabled: true,  show: false, opts: {} },
    { filterId: 'reject-artifacts', enabled: true,  show: true,  opts: { thresholdPct: 20, passes: 3 } },
    { filterId: 'amp-fit',          enabled: false, show: false, opts: { windowSec: 12, order: 1 } }, // opt-in visualization
    { filterId: 'mayer',            enabled: false, show: false, opts: { freqHz: 0.10 } },            // opt-in visualization
    { filterId: 'fit-envelope',     enabled: false, show: false, opts: {} },                         // opt-in visualization
  ],
};

//
// BLE
//
async function connect() {
  try {
    setStatus('Requesting device…');
    state.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
    });
    state.device.addEventListener('gattserverdisconnected', onDisconnect);
    setStatus('Connecting GATT…');
    const server = await state.device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    state.hrChar = await service.getCharacteristic('heart_rate_measurement');
    await state.hrChar.startNotifications();
    state.hrChar.addEventListener('characteristicvaluechanged', onHRNotification);
    setStatus(`Connected — ${state.device.name || 'unknown'}`, 'ok');
    document.getElementById('connect').disabled = true;
    document.getElementById('connect').classList.add('connected');
    document.getElementById('connect-cap').textContent = 'Connected';
    document.getElementById('record').disabled = false;
    startSession();   // session runs automatically once HR data is flowing
  } catch (e) {
    console.error(e);
    setStatus('Connect failed: ' + e.message, 'warn');
  }
}

function onDisconnect() {
  setStatus('Disconnected', 'warn');
  document.getElementById('connect').disabled = false;
  document.getElementById('connect').classList.remove('connected');
  document.getElementById('connect-cap').textContent = 'Connect';
  document.getElementById('record').disabled = true;
  stopSession();
}

// Append a raw RR beat to whichever collectors are active. Each search sample (while
// measuring) and each recording keeps its OWN beat series — so the drift-corrected window
// fit is independent of the rolling log's retention, and the raw beats ride along in the
// exported JSON for offline re-analysis / backtracing.
function collectBeat(t, rr) {
  if (state.search.status === 'running' && state.search.currentPhase === 'measuring') {
    const cur = state.search.samples[state.search.currentStepIdx];
    if (cur) cur.rr.push({ t, rr });
  }
  if (state.recording.active && state.recording.sample) state.recording.sample.rr.push({ t, rr });
}

function onHRNotification(event) {
  const v = event.target.value;
  const flags = v.getUint8(0);
  const is16 = flags & 0x01;
  const hasEE = flags & 0x08;
  const hasRR = flags & 0x10;
  let offset = 1;
  let hr;
  if (is16) { hr = v.getUint16(offset, true); offset += 2; }
  else      { hr = v.getUint8(offset);         offset += 1; }
  if (hasEE) offset += 2;

  const now = performance.now();
  state.hrLog.push({ t: now, hr });
  pruneLog(state.hrLog, 90_000); // keep 90s

  if (hasRR) {
    while (offset + 1 < v.byteLength) {
      const rr1024 = v.getUint16(offset, true);
      offset += 2;
      const rrMs = rr1024 * 1000 / 1024;
      state.rrLog.push({ t: now, rr: rrMs });
      collectBeat(now, rrMs);
    }
    pruneLog(state.rrLog, 90_000);
  }

  document.getElementById('hr').textContent = hr;
  updateDerivedMetrics();
}

function pruneLog(log, windowMs) {
  const cutoff = performance.now() - windowMs;
  while (log.length && log[0].t < cutoff) log.shift();
}

// Raw pipeline input for the live window: prefer real RR intervals (fine, 1/1024 s resolution),
// fall back to RR synthesized from the integer HR log. Source selection only — no filtering.
function buildInput(cutoff) {
  if (state.rrLog.length >= 5) {
    const s = [];
    for (const p of state.rrLog) if (p.t >= cutoff && p.rr > 0) s.push({ t: p.t, rr: p.rr });
    if (s.length >= 5) return s;
  }
  return state.hrLog.filter(p => p.t >= cutoff && p.hr > 0).map(p => ({ t: p.t, rr: 60000 / p.hr }));
}

function pipelineCtx(windowMs) {
  return { brpm: parseFloat(document.getElementById('brpm').value), now: performance.now(), windowMs };
}

// The stages that feed the metric/score: measurement (cleaning) filters only. Analysis filters
// (amp-fit, mayer, fit-envelope) are visualization overlays and must never change the number.
function measurementStages() {
  return state.pipeline.filter(s => { const f = FILTERS[s.filterId]; return f && f.role !== 'analysis'; });
}

// Serializable description of the pipeline that produced a result — recorded in exports so a
// metric (e.g. windowAmp) is interpretable: which stages were applied, shown, and with what opts.
function pipelineSnapshot() {
  return state.pipeline.map(s => {
    const f = FILTERS[s.filterId] || {};
    const role = f.role || 'measurement';
    return {
      filterId: s.filterId,
      label: f.label,
      role,
      enabled: !!s.enabled,
      show: s.show !== false,
      // Only enabled, non-viz, measurement filters actually feed the score.
      feedsScore: !!s.enabled && !f.viz && role === 'measurement',
      opts: { ...s.opts },
    };
  });
}

// Export form of a sample: the bulk beat series is written columnar (struct-of-arrays) — far
// smaller than repeating {t,rr} keys per beat, and loads straight into array/columnar tooling.
// Scalar stats + cycleAmplitudes (already a flat array) stay as-is.
function serializeSample(s) {
  const cols = pts => ({ t: (pts || []).map(p => p.t), rr: (pts || []).map(p => p.rr) });
  const beats = cols(s.rr);
  if (beats.t.length !== beats.rr.length) console.warn('serializeSample: beat array length mismatch');
  // `output` is the MEASUREMENT signal the score was computed on (cleaning stages only). `marks`
  // are every active filter's overlay (full pipeline) — so the export shows both the number's basis
  // and all the visualizations, columnar.
  const meas = runPipeline(s.rr || [], measurementStages(), { brpm: s.rate });
  const full = runPipeline(s.rr || [], state.pipeline, { brpm: s.rate }, { marksFor: 'active' });
  const out = { ...s, beats };
  delete out.rr;
  out.output = cols(meas.signal);
  out.marks = full.marks.map(m => ({ filterId: m.filterId, kind: m.kind, ...cols(m.data) }));
  return out;
}

// Persist the pipeline config (enabled + opts per stage) to localStorage.
const PIPELINE_KEY = 'hrv:pipeline';
function savePipeline() {
  try {
    localStorage.setItem(PIPELINE_KEY, JSON.stringify(
      state.pipeline.map(s => ({ filterId: s.filterId, enabled: s.enabled, show: s.show, opts: s.opts }))));
  } catch (_) {}
}
function restorePipeline() {
  try {
    const saved = JSON.parse(localStorage.getItem(PIPELINE_KEY));
    if (!Array.isArray(saved)) return;
    // Merge saved settings ONTO the current default stack (state.pipeline as seeded), keyed by
    // filterId. This keeps the default set + order as the source of truth, so filters added in a
    // later version (e.g. dedup) still appear even when older saved configs predate them.
    const savedById = {};
    for (const s of saved) if (FILTERS[s.filterId]) savedById[s.filterId] = s;
    state.pipeline = state.pipeline.map(def => {
      const s = savedById[def.filterId];
      if (!s) return def;                                // new default filter, no saved entry
      return {
        filterId: def.filterId,
        enabled: s.enabled !== false,
        show: s.show !== false,
        opts: { ...FILTERS[def.filterId].defaults, ...def.opts, ...(s.opts || {}) },
      };
    });
  } catch (_) {}
}

// Build the pipeline tweak UI from each filter's `schema`. The engine stays agnostic to option
// meaning — schema only says how to render a control and where to write its value.
function renderPipelineControls() {
  const host = document.getElementById('pipeline-controls');
  if (!host) return;
  host.innerHTML = '';
  for (const stage of state.pipeline) {
    const f = FILTERS[stage.filterId];
    if (!f) continue;
    // viz filters never transform — their "active" state is just whether they're shown.
    const active = f.viz ? (stage.show !== false) : stage.enabled;
    const wrap = document.createElement('div');
    wrap.className = 'pipeline-stage' + (active ? '' : ' off');

    const head = document.createElement('div');
    head.className = 'pipeline-stage-head';

    const swatch = document.createElement('span');
    swatch.className = 'pipeline-swatch';
    swatch.style.background = f.color;
    const name = document.createElement('span');
    name.textContent = f.label;

    // Enabled — apply the transform. Omitted for viz (visualization-only) filters.
    const enableLab = document.createElement('label');
    enableLab.className = 'pipeline-enable';
    if (f.viz) {
      enableLab.title = 'Visualization only — no signal transform';
      enableLab.append(swatch, name);
    } else {
      enableLab.title = 'Apply this filter to the signal';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = stage.enabled;
      cb.addEventListener('change', () => {
        stage.enabled = cb.checked;
        wrap.classList.toggle('off', !cb.checked);
        savePipeline();
        updateScoreBasis();        // measurement toggles change what feeds the number
      });
      enableLab.append(cb, swatch, name);
    }
    // Role badge — measurement filters feed the score; analysis filters are overlays only.
    const role = f.role || 'measurement';
    const badge = document.createElement('span');
    badge.className = 'pipeline-role ' + role;
    badge.textContent = role === 'analysis' ? 'overlay' : 'measurement';
    enableLab.append(badge);

    // Show — render this filter's visual on the graph (independent of Enabled).
    const showLab = document.createElement('label');
    showLab.className = 'pipeline-show';
    showLab.title = 'Show this filter on the graph (works even when not applied)';
    const showCb = document.createElement('input');
    showCb.type = 'checkbox';
    showCb.checked = stage.show !== false;
    showCb.addEventListener('change', () => {
      stage.show = showCb.checked;
      if (f.viz) wrap.classList.toggle('off', !showCb.checked);
      savePipeline();
    });
    const showTxt = document.createElement('span');
    showTxt.textContent = 'show';
    showLab.append(showCb, showTxt);

    head.append(enableLab, showLab);
    wrap.append(head);

    for (const field of (f.schema || [])) wrap.append(renderPipelineField(stage, field));

    const brpm = parseFloat(document.getElementById('brpm').value) || 6;
    const minSpan = filterMinSpanSec(f, stage.opts, { brpm });
    const min = filterMinSamples(f, stage.opts);
    let req = '';
    if (minSpan > 0) req = `needs ≥ ${Math.round(minSpan)} s of data to apply (scales with rate)`;
    else if (min > 1) req = `needs ≥ ${min} samples to apply`;
    if (req) {
      const note = document.createElement('div');
      note.className = 'pipeline-min';
      note.textContent = req;
      wrap.append(note);
    }
    host.append(wrap);
  }
  updateScoreBasis();
}

// Show which enabled stages actually feed the metric/score (measurement, non-viz, enabled).
function updateScoreBasis() {
  const el = document.getElementById('score-basis');
  if (!el) return;
  const names = state.pipeline
    .filter(s => { const f = FILTERS[s.filterId]; return f && s.enabled && !f.viz && (f.role || 'measurement') !== 'analysis'; })
    .map(s => FILTERS[s.filterId].label);
  el.innerHTML = `<strong>Score basis:</strong> ${names.length ? names.join(' → ') : 'raw beats (no cleaning)'}`;
}

function renderPipelineField(stage, field) {
  const row = document.createElement('div');
  row.className = 'pipeline-field';
  const lab = document.createElement('label');
  lab.textContent = field.label;
  const val = document.createElement('span');
  val.className = 'val-display';
  const input = document.createElement('input');
  const cur = stage.opts[field.key];

  if (field.type === 'toggle') {
    input.type = 'checkbox';
    input.checked = !!cur;
    input.addEventListener('change', () => { stage.opts[field.key] = input.checked; savePipeline(); });
    val.textContent = '';
  } else {
    input.type = (field.type === 'range') ? 'range' : 'number';
    if (field.min != null) input.min = field.min;
    if (field.max != null) input.max = field.max;
    input.step = field.step != null ? field.step : (field.type === 'int' ? 1 : 'any');
    input.value = cur;
    val.textContent = cur;
    input.addEventListener('input', () => {
      let v = parseFloat(input.value);
      if (field.type === 'int') v = Math.round(v);
      stage.opts[field.key] = v;
      val.textContent = v;
      savePipeline();
    });
  }
  row.append(lab, input, val);
  return row;
}

restorePipeline();
renderPipelineControls();

// Analyzer selection (composable searches) — toggles for which analyzers run, persisted.
const ANALYZERS_KEY = 'hrv:analyzers';
function saveAnalyzers() { try { localStorage.setItem(ANALYZERS_KEY, JSON.stringify(state.search.analyzers)); } catch (_) {} }
function restoreAnalyzers() {
  try {
    const saved = JSON.parse(localStorage.getItem(ANALYZERS_KEY));
    if (Array.isArray(saved)) {
      const valid = saved.filter(id => ANALYZERS[id]);
      if (valid.length) state.search.analyzers = valid;
    }
  } catch (_) {}
}
function renderAnalyzerControls() {
  const host = document.getElementById('analyzer-controls');
  if (!host) return;
  host.innerHTML = '';
  for (const id of Object.keys(ANALYZERS)) {
    const row = document.createElement('label');
    row.className = 'analyzer-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.search.analyzers.includes(id);
    cb.addEventListener('change', () => {
      const set = new Set(state.search.analyzers);
      cb.checked ? set.add(id) : set.delete(id);
      state.search.analyzers = Object.keys(ANALYZERS).filter(x => set.has(x));   // keep registry order
      saveAnalyzers();
    });
    const name = document.createElement('span');
    name.textContent = ANALYZERS[id].label;
    row.append(cb, name);
    host.append(row);
  }
}
// NOTE: restoreAnalyzers()/renderAnalyzerControls() are invoked after the ANALYZERS registry is
// defined (const, lower in the file) — calling them here would hit its temporal dead zone.

// RSA amplitude over the window, in both RR-interval (ms) and heart-rate (bpm) units.
// ms is the physiological standard and is free of the HR² scaling that shrinks the bpm
// value at low resting heart rates; bpm is kept as an intuitive secondary readout.
function computeRsa(windowMs) {
  const brpm = parseFloat(document.getElementById('brpm').value);
  const w = 2 * Math.PI * (brpm / 60);
  const beats = runPipeline(buildInput(performance.now() - windowMs), measurementStages(), pipelineCtx(windowMs)).signal;
  if (beats.length < 5) return null;
  const ms = fitPeakToTrough(beats.map(p => ({ t: p.t, v: p.rr })), w);
  const bpm = fitPeakToTrough(beats.map(p => ({ t: p.t, v: 60000 / p.rr })), w);
  return (ms == null) ? null : { ms, bpm };
}

function updateDerivedMetrics() {
  // Cycle amplitude: respiratory-frequency RSA swing over the last breath, in ms (primary,
  // stored/measured) and bpm (secondary). ms is fair across resting heart rates.
  const brpm = parseFloat(document.getElementById('brpm').value);
  const cycleMs = 60_000 / brpm;
  const rsa = computeRsa(cycleMs);
  document.getElementById('amp').textContent = rsa ? rsa.ms.toFixed(0) : '--';
  document.getElementById('amp-bpm').textContent = (rsa && rsa.bpm != null) ? rsa.bpm.toFixed(1) : '--';

  // RMSSD over last 60s of RR intervals — through the pipeline, so notification echoes
  // (zero successive-differences) and artifacts don't distort the value.
  const rrCutoff = performance.now() - 60_000;
  const recent = runPipeline(buildInput(rrCutoff), measurementStages(), pipelineCtx(60_000)).signal.map(p => p.rr);
  if (recent.length >= 4) {
    let sumSq = 0;
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i] - recent[i-1];
      sumSq += d * d;
    }
    const rmssd = Math.sqrt(sumSq / (recent.length - 1));
    document.getElementById('rmssd').textContent = rmssd.toFixed(0);
  } else {
    document.getElementById('rmssd').textContent = '--';
  }
}

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
  droneLevel: 0.5,           // 0–1 mix scalar for the drone
  chimeLevel: 1.0,           // 0–1 mix scalar for the chimes
  freqLow: 196,              // G3
  freqHigh: 220,             // A3 — whole tone glide, much less siren-like than the previous fifth
};

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

  // Subtle pitch glide (default whole tone — well below "siren" perception)
  const baseFreq = isInhale
    ? audio.freqLow + (audio.freqHigh - audio.freqLow) * eased
    : audio.freqHigh - (audio.freqHigh - audio.freqLow) * eased;
  for (const { osc, ratio } of audio.oscs) {
    osc.frequency.setTargetAtTime(baseFreq * ratio, audio.ctx.currentTime, 0.08);
  }

  // Drone amplitude swell — 60% at exhale-bottom, 100% at inhale-top.
  // This is the primary breath cue; pitch is now a small secondary motion.
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

// Two chimes per breath cycle — each anchored an octave above its drone position.
// "Bottom" — start of inhale, drone at freqLow → low-pitched gong (matches the low position).
// "Top"    — start of exhale, drone at freqHigh → higher-pitched gong (matches the high position).
function playBottomChime() { playChime(audio.freqLow  * 2, 1.0); }
function playTopChime()    { playChime(audio.freqHigh * 2, 0.85); }

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
    if (audio.active) playBottomChime();
  }

  // Inhale → exhale transition — fire TOP chime (softer, lower release cue)
  if (state.lastIsInhale === true && isInhale === false) {
    if (audio.active) playTopChime();
  }
  state.lastIsInhale = isInhale;

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

//
// Chart — HR over last 60s, with overlaid breath phase shading
//
const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Resolve a CSS custom-property colour (e.g. "var(--warn)") to a concrete value canvas can use.
function cssVarColor(c) {
  if (typeof c === 'string' && c.startsWith('var(')) {
    const name = c.slice(4, -1).trim();
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#fbbf24';
  }
  return c;
}
// Draw a polyline source (points already in the panel's value channel).
function drawLine(points, stroke, width, xOf, yOf) {
  if (points.length < 2) return;
  ctx.strokeStyle = cssVarColor(stroke);
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const x = xOf(points[i].t), y = yOf(points[i].v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
// Draw point marks — 'x' (e.g. dropped artifacts) or 'dot' (e.g. collapsed echoes).
function drawPointMarks(points, color, xOf, yOf, glyph = 'x') {
  const c = cssVarColor(color);
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
  ctx.lineWidth = 1.5;
  const r = glyph === 'dot' ? 2.2 : 3.5;
  for (const p of points) {
    const x = xOf(p.t), y = yOf(p.v);
    ctx.beginPath();
    if (glyph === 'dot') {
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
      ctx.stroke();
    }
  }
}

// The signal graph: a single HR-channel panel fed by the pipeline. It draws the filtered
// output as the solid trace, the pre-filter input as a faint ghost (when filtering changed
// anything), and each filter's marks (dropped beats as X's). Built on a general source/marks
// model so more sources or panels can be added later without touching the renderer internals.
// Frozen fit store: windowed-fit overlays (amp-fit, fit-envelope) ARE the measurement fit. Each
// window is computed ONCE — when the cleaned buffer first contains it complete — at that window's
// brpm, then frozen: never recomputed on new beats, on scroll, or on a later rate change. A record
// is dropped only when its beats are pruned from the buffer.
const FIT_RETENTION_MS = 90_000;
const fitStore = {};   // filterId -> { records:[{t0,t1,marks}], cursor, sig }
function resetFitStores() { for (const k in fitStore) delete fitStore[k]; }

function updateFitStores(now) {
  const brpm = parseFloat(document.getElementById('brpm').value) || 6;
  const w = 2 * Math.PI * (brpm / 60);
  const cutoff = now - FIT_RETENTION_MS;
  const buffer = runPipeline(buildInput(cutoff), measurementStages(), { brpm }).signal;  // cleaned beats
  for (const stage of state.pipeline) {
    const f = FILTERS[stage.filterId];
    if (!f || !f.windowed) continue;
    if (stage.show === false) { delete fitStore[f.id]; continue; }                 // hidden → drop store
    const sig = `${stage.opts.windowBreaths ?? 1}|${stage.opts.overlap ?? 0}|${stage.opts.order ?? ''}`;
    let store = fitStore[f.id];
    if (!store || store.sig !== sig) store = fitStore[f.id] = { records: [], cursor: null, sig };  // param change → recompute forward
    if (buffer.length < 2) continue;
    const L = (stage.opts.windowBreaths ?? 1) * (60000 / brpm);
    const step = Math.max(250, L * (1 - (stage.opts.overlap ?? 0)));
    if (store.cursor == null || store.cursor < buffer[0].t) store.cursor = buffer[0].t;
    const latest = buffer[buffer.length - 1].t;
    while (store.cursor + L <= latest) {                       // only fully-collected windows
      const c = store.cursor;
      const win = buffer.filter(p => p.t >= c && p.t < c + L);
      const marks = f.fitWindow(win, w, stage.opts);           // computed once at this window's rate
      if (marks) store.records.push({ t0: c, t1: c + L, marks });
      store.cursor += step;
    }
    store.records = store.records.filter(r => r.t0 >= cutoff); // drop when beats prune
  }
}

function storedFitMarks(now) {
  const tMin = now - 60_000, out = [];
  for (const id in fitStore) for (const r of fitStore[id].records) if (r.t1 >= tMin) out.push(...r.marks);
  return out;
}

// Chart pipeline = everything except the windowed-fit overlays (those come from the frozen store).
function chartStages() {
  return state.pipeline.filter(s => { const f = FILTERS[s.filterId]; return f && !f.windowed; });
}

let chartFit = null;   // cached pipeline result; recomputed only when the beats/rate change
function drawChart() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  const windowMs = 60_000;
  const now = performance.now();
  const tMin = now - windowMs;

  const input = buildInput(tMin);
  if (input.length < 2) { requestAnimationFrame(drawChart); return; }
  // Recompute the fits only when the windowed beat set actually changes (a beat arrived or scrolled
  // out) or the rate changed — NOT every frame. Otherwise the least-squares fits jitter as the
  // 60 s window slides continuously. Between recomputes we just rescroll the cached result, which
  // carries absolute timestamps, so the overlays stay stable and only move with real new data.
  const brpmNow = parseFloat(document.getElementById('brpm').value);
  const key = input.length + '|' + input[input.length - 1].t + '|' + brpmNow;
  if (!chartFit || chartFit.key !== key) {
    chartFit = { key, input, piped: runPipeline(input, chartStages(), pipelineCtx(windowMs)) };
    updateFitStores(now);   // append any newly-completed windowed fits (frozen); cheap, only on change
  }
  const piped = chartFit.piped;

  // Sources, in the HR (bpm) channel.
  const toHr = p => ({ t: p.t, v: 60000 / p.rr });
  const ghost = chartFit.input.map(toHr);
  const output = piped.signal.map(toHr);
  const lines = [];
  if (piped.marks.length) lines.push({ points: ghost, stroke: 'rgba(110,231,183,0.22)', width: 1 });
  lines.push({ points: output.length ? output : ghost, stroke: '#6ee7b7', width: 2 });

  // Autoscale across every drawn line.
  let vMin = Infinity, vMax = -Infinity;
  for (const ln of lines) for (const p of ln.points) { if (p.v < vMin) vMin = p.v; if (p.v > vMax) vMax = p.v; }
  if (!isFinite(vMin)) { requestAnimationFrame(drawChart); return; }
  const pad = Math.max(2, (vMax - vMin) * 0.15);
  vMin -= pad; vMax += pad;
  if (vMax - vMin < 6) { const c = (vMin + vMax) / 2; vMin = c - 3; vMax = c + 3; }

  const xOf = t => ((t - tMin) / windowMs) * W;
  const yOf = v => H - ((v - vMin) / (vMax - vMin)) * H;

  // Breath-phase overlay (only when running)
  if (state.running && state.sessionStart) {
    const brpm = parseFloat(document.getElementById('brpm').value);
    const inhaleFrac = parseFloat(document.getElementById('inhale-frac').value);
    const cycleMs = 60_000 / brpm;
    const inhaleMs = cycleMs * inhaleFrac;
    const firstCycleStart = state.sessionStart + Math.floor((tMin - state.sessionStart) / cycleMs) * cycleMs;
    for (let cs = firstCycleStart; cs < now; cs += cycleMs) {
      const inhaleEnd = cs + inhaleMs;
      const cycleEnd = cs + cycleMs;
      const x1 = xOf(Math.max(cs, tMin)), x2 = xOf(Math.min(inhaleEnd, now));
      if (x2 > x1) { ctx.fillStyle = 'rgba(96,165,250,0.08)'; ctx.fillRect(x1, 0, x2 - x1, H); }
      const x3 = xOf(Math.max(inhaleEnd, tMin)), x4 = xOf(Math.min(cycleEnd, now));
      if (x4 > x3) { ctx.fillStyle = 'rgba(244,114,182,0.08)'; ctx.fillRect(x3, 0, x4 - x3, H); }
    }
  }

  // y gridlines at even integer HR
  ctx.strokeStyle = '#2a2f3a';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8a93a3';
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  for (let hr = Math.ceil(vMin); hr <= Math.floor(vMax); hr++) {
    if ((hr % 2) !== 0) continue;
    const y = yOf(hr);
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillText(hr.toString(), 4, y - 2);
  }

  // Line sources, then mark overlays (pipeline marks + the frozen windowed-fit overlays).
  for (const ln of lines) drawLine(ln.points, ln.stroke, ln.width, xOf, yOf);
  const marks = piped.marks.concat(storedFitMarks(now));
  for (const m of marks) {
    if (m.kind === 'points') drawPointMarks(m.data.map(toHr), m.color, xOf, yOf, m.style && m.style.glyph);
    else if (m.kind === 'line') drawLine(m.data.map(toHr), m.color, 1.5, xOf, yOf);
  }

  // Axis unit labels — y is heart rate (bpm), x is the last 60 s of time
  ctx.fillStyle = '#8a93a3';
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('bpm', 4, 12);
  ctx.fillText('−60 s', 4, H - 5);
  ctx.textAlign = 'right';
  ctx.fillText('now', W - 4, H - 5);
  ctx.textAlign = 'left';

  requestAnimationFrame(drawChart);
}
requestAnimationFrame(drawChart);

//
// UI wiring
//
//
// Demo mode
//
function toggleDemo() {
  state.demoActive = !state.demoActive;
  const btn = document.getElementById('demo');
  const bar = document.getElementById('demo-bar');
  if (state.demoActive) {
    btn.classList.add('active');
    btn.textContent = 'Exit demo';
    document.body.classList.add('demo-active');
    document.getElementById('dev-drawer').open = true;
    document.getElementById('connect').disabled = true;
    document.getElementById('record').disabled = false;
    setStatus('Demo mode — simulated HR stream, pacer running', 'ok');
    startSession();
    scheduleDemoBeat();
  } else {
    btn.classList.remove('active');
    btn.textContent = 'Demo mode';
    document.body.classList.remove('demo-active');
    document.getElementById('dev-drawer').open = false;
    document.getElementById('connect').disabled = false;
    document.getElementById('record').disabled = true;
    stopSession();
    if (state.demoBeatTimer) { clearTimeout(state.demoBeatTimer); state.demoBeatTimer = null; }
    setStatus('Not connected');
    document.getElementById('hr').textContent = '--';
    label.textContent = '—';
    circle.setAttribute('r', '60');
  }
  updateDemoDisplay();
}

function scheduleDemoBeat() {
  if (!state.demoActive) return;
  const now = performance.now();

  // Modulation matches the pacer's sinusoidal easing: 0 at cycle start, 1 at end of inhale, 0 at end of exhale
  let mod = 0;
  let effectiveRsa = state.demoRsaAmp;
  if (state.running && state.sessionStart !== null) {
    const brpm = parseFloat(document.getElementById('brpm').value);
    const inhaleFrac = parseFloat(document.getElementById('inhale-frac').value);
    // Use the pacer's continuous breath phase so simulated HR tracks the smooth cue.
    const bp = state.breathPhase;
    if (bp < inhaleFrac) {
      const f = bp / inhaleFrac;
      mod = (1 - Math.cos(Math.PI * f)) / 2;
    } else {
      const f = (bp - inhaleFrac) / (1 - inhaleFrac);
      mod = 1 - (1 - Math.cos(Math.PI * f)) / 2;
    }

    // Simulated resonance: RSA amplitude follows a Gaussian peak around demoResonanceFreq.
    // At resonance: 100% of demoRsaAmp. ±1 width away: ~37%. Plus a non-zero floor (30%) and small jitter.
    const dist = Math.abs(brpm - state.demoResonanceFreq);
    const resFactor = Math.exp(-Math.pow(dist / state.demoResonanceWidth, 2));
    const noise = (Math.random() - 0.5) * 0.1;
    effectiveRsa = state.demoRsaAmp * (0.30 + 0.70 * resFactor + noise);
  }
  const hrTarget = state.demoBaseline + effectiveRsa * (2 * mod - 1);
  const jitter = (Math.random() - 0.5) * 0.6;
  const hr = Math.max(30, hrTarget + jitter);
  const rrMs = 60_000 / hr;

  state.hrLog.push({ t: now, hr: Math.round(hr) });
  state.rrLog.push({ t: now, rr: rrMs });
  collectBeat(now, rrMs);
  pruneLog(state.hrLog, 90_000);
  pruneLog(state.rrLog, 90_000);

  document.getElementById('hr').textContent = Math.round(hr);
  updateDerivedMetrics();

  state.demoBeatTimer = setTimeout(scheduleDemoBeat, rrMs);
}

function updateDemoDisplay() {
  document.getElementById('demo-baseline-val').textContent = state.demoBaseline.toString();
  document.getElementById('demo-rsa-val').textContent = state.demoRsaAmp.toFixed(1);
  document.getElementById('demo-resonance-val').textContent = state.demoResonanceFreq.toFixed(1);
}

//
// Keyboard (active only in demo mode)
//
window.addEventListener('keydown', e => {
  if (!state.demoActive) return;
  const slider = document.getElementById('brpm');
  const inhaleSlider = document.getElementById('inhale-frac');
  let handled = true;
  switch (e.key) {
    case 'ArrowLeft':
      slider.value = Math.max(parseFloat(slider.min), parseFloat(slider.value) - 0.1).toFixed(1);
      slider.dispatchEvent(new Event('input'));
      break;
    case 'ArrowRight':
      slider.value = Math.min(parseFloat(slider.max), parseFloat(slider.value) + 0.1).toFixed(1);
      slider.dispatchEvent(new Event('input'));
      break;
    case 'ArrowUp':
      inhaleSlider.value = Math.min(parseFloat(inhaleSlider.max), parseFloat(inhaleSlider.value) + 0.01).toFixed(2);
      inhaleSlider.dispatchEvent(new Event('input'));
      break;
    case 'ArrowDown':
      inhaleSlider.value = Math.max(parseFloat(inhaleSlider.min), parseFloat(inhaleSlider.value) - 0.01).toFixed(2);
      inhaleSlider.dispatchEvent(new Event('input'));
      break;
    case '+': case '=':
      state.demoBaseline = Math.min(200, state.demoBaseline + 1);
      updateDemoDisplay();
      break;
    case '-': case '_':
      state.demoBaseline = Math.max(30, state.demoBaseline - 1);
      updateDemoDisplay();
      break;
    case '.': case '>':
      state.demoRsaAmp = Math.min(30, state.demoRsaAmp + 0.5);
      updateDemoDisplay();
      break;
    case ',': case '<':
      state.demoRsaAmp = Math.max(0, state.demoRsaAmp - 0.5);
      updateDemoDisplay();
      break;
    case '0':
      state.demoResonanceFreq = Math.min(8.0, state.demoResonanceFreq + 0.1);
      updateDemoDisplay();
      break;
    case '9':
      state.demoResonanceFreq = Math.max(3.0, state.demoResonanceFreq - 0.1);
      updateDemoDisplay();
      break;
    default:
      handled = false;
  }
  if (handled) e.preventDefault();
});

document.getElementById('demo').addEventListener('click', toggleDemo);
document.getElementById('connect').addEventListener('click', connect);

//
// Fullscreen toggle — a distraction-free, screensaver-proof view for long sessions.
//
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    (document.documentElement.requestFullscreen?.() || Promise.reject())
      .catch(() => setStatus('Fullscreen not available', 'warn'));
  } else {
    document.exitFullscreen?.();
  }
}
function syncFullscreenIcon() {
  const fs = !!document.fullscreenElement;
  const btn = document.getElementById('fullscreen');
  document.getElementById('fullscreen-enter-icon').style.display = fs ? 'none' : '';
  document.getElementById('fullscreen-exit-icon').style.display = fs ? '' : 'none';
  document.getElementById('fullscreen-cap').textContent = fs ? 'Exit' : 'Fullscreen';
  btn.classList.toggle('active', fs);
}
document.getElementById('fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFullscreenIcon);

//
// Clear — discard logged HR/RR data and reset the metric readouts + graph.
// Leaves the session running and panels untouched; data simply starts fresh.
//
function clearLoggedData() {
  state.rrLog = [];
  state.hrLog = [];
  state.sessionAmps = [];
  resetFitStores();
  chartFit = null;
  document.getElementById('hr').textContent = '--';
  document.getElementById('amp').textContent = '--';
  document.getElementById('amp-bpm').textContent = '--';
  document.getElementById('rmssd').textContent = '--';
  setStatus('Logged data cleared');
}
document.getElementById('clear').addEventListener('click', clearLoggedData);

//
// Prose font-size tuner — persists to localStorage
//
const PROSE_KEY = 'hrv:proseSize';
const PROSE_MIN = 14, PROSE_MAX = 36, PROSE_DEFAULT = 22;

function setProseSize(px) {
  const clamped = Math.max(PROSE_MIN, Math.min(PROSE_MAX, px));
  document.documentElement.style.setProperty('--prose-size', clamped + 'px');
  document.getElementById('prose-size-display').textContent = clamped + 'px';
  try { localStorage.setItem(PROSE_KEY, String(clamped)); } catch (_) {}
}
function bumpProseSize(delta) {
  const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--prose-size'), 10) || PROSE_DEFAULT;
  setProseSize(current + delta);
}
document.getElementById('prose-smaller').addEventListener('click', () => bumpProseSize(-1));
document.getElementById('prose-larger').addEventListener('click', () => bumpProseSize(+1));

(function restoreProseSize() {
  try {
    const saved = parseInt(localStorage.getItem(PROSE_KEY), 10);
    if (!isNaN(saved)) setProseSize(saved); else setProseSize(PROSE_DEFAULT);
  } catch (_) { setProseSize(PROSE_DEFAULT); }
})();
// Session runs automatically while connected (or in demo) — no manual start.
async function startSession() {
  if (state.running) return;
  state.sessionStart = performance.now();
  state.running = true;
  state.breathPhase = 0;
  state.lastFrameT = null;
  state.lastIsInhale = null;
  state.sessionAmps = [];
  document.getElementById('summary').style.display = 'none';
  requestWakeLock();
  if (audio.enabled) await startAudioPacer();
  pacerLoop();
}
function stopSession() {
  if (state.search.status === 'running') cancelSearch();
  if (state.recording.active) stopRecording();
  state.running = false;
  label.textContent = '—';
  circle.setAttribute('r', '60');
  stopAudioPacer();
  releaseWakeLock();
  showSessionSummary();
}

//
// Screen Wake Lock — keep the display awake during sessions and long sweeps,
// so the screensaver/lock screen never interrupts a relaxed session.
// The lock is auto-released when the tab is hidden; we re-acquire on return.
//
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (_) {
    // User-agent may reject (e.g. low battery, no permission) — degrade silently.
  }
}
function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) requestWakeLock();
});

//
// Record — capture the feedback at the current single setting.
// Produces the same JSON shape the sweep exports, with one sample.
//
document.getElementById('record').addEventListener('click', () => {
  if (state.recording.active) stopRecording();
  else startRecording();
});

function startRecording() {
  if (!state.running) { setStatus('Connect a strap or enable Demo first', 'warn'); return; }
  if (state.search.status === 'running') { setStatus('Sweep in progress — cancel it first', 'warn'); return; }
  const rate = parseFloat(document.getElementById('brpm').value);
  const inhaleFraction = parseFloat(document.getElementById('inhale-frac').value);
  const now = performance.now();
  state.recording = {
    active: true,
    startedAt: Date.now(),
    rate,
    inhaleFraction,
    sample: { rate, settleStart: now, measureStart: now, measureEnd: null, cycleAmplitudes: [], rr: [] },
  };
  const btn = document.getElementById('record');
  btn.classList.add('recording');
  btn.title = 'Stop recording';
  btn.setAttribute('aria-label', 'Stop recording');
  document.getElementById('record-cap').textContent = 'Stop';
  // Lock breathing controls so the recorded setting stays constant.
  document.getElementById('brpm').disabled = true;
  document.getElementById('inhale-frac').disabled = true;
  document.getElementById('search-start').disabled = true;
  setStatus(`Recording at ${rate.toFixed(1)} brpm…`, 'ok');
}

function stopRecording() {
  const rec = state.recording;
  if (!rec.active) return;
  rec.active = false;
  rec.sample.measureEnd = performance.now();
  computeSampleStats(rec.sample);
  const session = {
    startedAt: new Date(rec.startedAt).toISOString(),
    config: {
      rates: [rec.rate],
      settleSeconds: 0,
      measureSeconds: Math.round((rec.sample.measureEnd - rec.sample.measureStart) / 1000),
      inhaleFraction: rec.inhaleFraction,
    },
    pipeline: pipelineSnapshot(),
    samples: [serializeSample(rec.sample)],
    result: null,   // a single-setting recording has no rate to recommend — no sweep result
  };
  downloadJSON(session, `hrv-recording-${new Date(rec.startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
  const btn = document.getElementById('record');
  btn.classList.remove('recording');
  btn.title = 'Record at the current setting';
  btn.setAttribute('aria-label', 'Record at the current setting');
  document.getElementById('record-cap').textContent = 'Record';
  document.getElementById('brpm').disabled = false;
  document.getElementById('inhale-frac').disabled = false;
  document.getElementById('search-start').disabled = false;
  setStatus(rec.sample.n > 0
    ? `Recording saved — ${rec.sample.n} cycles, median ${rec.sample.median.toFixed(0)} ms`
    : 'Recording saved — no full cycles captured', rec.sample.n > 0 ? 'ok' : 'warn');
}

//
// Audio toggle
//
// Audio cue controls (volume, pitch, mix) are inert until the master toggle is on.
function setAudioControlsEnabled(on) {
  ['volume', 'freq-low', 'freq-high', 'drone-level', 'chime-level']
    .forEach(id => document.getElementById(id).disabled = !on);
}

document.getElementById('audio-toggle').addEventListener('change', async (e) => {
  audio.enabled = e.target.checked;
  setAudioControlsEnabled(audio.enabled);
  if (audio.enabled && state.running) {
    await startAudioPacer();
  } else if (!audio.enabled) {
    stopAudioPacer();
  }
});
setAudioControlsEnabled(false);
document.getElementById('volume').addEventListener('input', (e) => {
  audio.volume = parseFloat(e.target.value);
  document.getElementById('volume-display').textContent = Math.round(audio.volume * 100) + '%';
  if (audio.active && audio.ctx) {
    audio.master.gain.setTargetAtTime(audio.volume, audio.ctx.currentTime, 0.1);
  }
});

document.getElementById('drone-level').addEventListener('input', (e) => {
  audio.droneLevel = parseFloat(e.target.value);
  document.getElementById('drone-level-display').textContent = Math.round(audio.droneLevel * 100);
  // pacerLoop calls updateAudioBreath every frame — it picks up the new value automatically.
});
document.getElementById('chime-level').addEventListener('input', (e) => {
  audio.chimeLevel = parseFloat(e.target.value);
  document.getElementById('chime-level-display').textContent = Math.round(audio.chimeLevel * 100);
});

document.getElementById('search-start').addEventListener('click', toggleSearch);
document.getElementById('search-cancel').addEventListener('click', () => {
  if (state.search.status === 'running') cancelSearch();
  else closeSearchPanel();
});
// Click (or Enter/Space on) a completed sweep bar to inspect its fit in the detail strip below.
// Delegated, because renderSearchBars rebuilds the bars' innerHTML on every UI tick.
(function wireFitInspector() {
  const bars = document.getElementById('search-bars');
  const open = e => {
    const bar = e.target.closest('.search-bar.clickable');
    if (!bar || bar.dataset.rate == null) return false;
    showFitDetail(parseFloat(bar.dataset.rate));
    return true;
  };
  bars.addEventListener('click', open);
  bars.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { if (open(e)) e.preventDefault(); }
  });
})();

//
// Pitch-range inputs
//
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function hzToNoteName(hz) {
  // A4 = 440 Hz, 12-TET
  const midi = Math.round(12 * Math.log2(hz / 440) + 69);
  const oct = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[midi % 12] + oct;
}
const INTERVAL_NAMES = {
  1: 'm2', 2: 'M2', 3: 'm3', 4: 'M3', 5: 'P4', 6: 'TT',
  7: 'P5', 8: 'm6', 9: 'M6', 10: 'm7', 11: 'M7', 12: 'P8',
};
function intervalName(low, high) {
  const semitones = Math.round(12 * Math.log2(high / low));
  return INTERVAL_NAMES[semitones] || `${semitones}st`;
}
function updatePitchDisplay() {
  const lo = audio.freqLow, hi = audio.freqHigh;
  document.getElementById('interval-display').textContent =
    `${hzToNoteName(lo)} → ${hzToNoteName(hi)} (${intervalName(lo, hi)})`;
}
function onPitchInput() {
  const lo = parseInt(document.getElementById('freq-low').value, 10);
  const hi = parseInt(document.getElementById('freq-high').value, 10);
  if (isNaN(lo) || isNaN(hi) || hi <= lo) return;
  audio.freqLow = lo;
  audio.freqHigh = hi;
  // Update existing oscillators immediately if running so the change is audible
  if (audio.active && audio.ctx) {
    for (const { osc, ratio } of audio.oscs) {
      osc.frequency.setTargetAtTime(lo * ratio, audio.ctx.currentTime, 0.2);
    }
  }
  updatePitchDisplay();
}
document.getElementById('freq-low').addEventListener('input', onPitchInput);
document.getElementById('freq-high').addEventListener('input', onPitchInput);
updatePitchDisplay();

//
// View mode (Full / Breather + feedback / Cue only)
//
function setViewMode(mode) {
  document.body.classList.remove('mode-feedback', 'mode-cue');
  if (mode === 'feedback') document.body.classList.add('mode-feedback');
  else if (mode === 'cue') document.body.classList.add('mode-cue');
  document.querySelectorAll('#view-mode .icon-btn').forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}
document.querySelectorAll('#view-mode .icon-btn').forEach(b => {
  b.addEventListener('click', () => setViewMode(b.dataset.mode));
});

// Tap the breathing circle to exit any breather mode back to Full.
document.querySelector('.pacer-wrap').addEventListener('click', () => {
  if (document.body.classList.contains('mode-feedback') ||
      document.body.classList.contains('mode-cue')) {
    setViewMode('full');
  }
});

//
// Resonance search (Train mode) — V1
// Sweep rates and timing come from the Sweep settings drawer (readSweepSettings).
//

function searchTotalSeconds() {
  const c = state.search.config;
  return c.rates.length * (c.settleSeconds + c.measureSeconds);
}

// Read the sweep configuration from the Sweep settings drawer.
function readSweepSettings() {
  const rates = document.getElementById('set-rates').value
    .split(',').map(s => parseFloat(s.trim())).filter(r => !isNaN(r) && r > 0);
  const settleSeconds = parseInt(document.getElementById('set-settle').value, 10) || 0;
  const measureSeconds = parseInt(document.getElementById('set-measure').value, 10) || 0;
  const passes = Math.max(1, parseInt(document.getElementById('set-passes').value, 10) || 1);
  const refineRounds = Math.max(0, parseInt(document.getElementById('set-refine-rounds').value, 10) || 0);
  return { rates, settleSeconds, measureSeconds, passes, refineRounds };
}

// Reflect the current sweep settings in the search button description and the drawer summary line.
function updateSweepDesc() {
  const btn = document.getElementById('search-start');   // tuning-fork toolbar button
  const cnt = document.getElementById('set-rates-count');
  const tot = document.getElementById('set-total');
  const { rates, settleSeconds, measureSeconds, passes, refineRounds } = readSweepSettings();
  if (cnt) cnt.textContent = rates.length + (rates.length === 1 ? ' rate' : ' rates') + (passes > 1 ? ` × ${passes}` : '');
  updateMeasureHint(rates, measureSeconds);
  if (rates.length < 2) {
    if (btn) btn.title = 'Find resonance frequency — enter at least two sweep rates in Settings → Sweep';
    if (tot) tot.textContent = '—';
    return;
  }
  const total = rates.length * passes * (settleSeconds + measureSeconds) * (1 + refineRounds);
  const mins = Math.max(1, Math.round(total / 60));
  const hi = Math.max(...rates), lo = Math.min(...rates);
  if (btn) btn.title =
    `Find resonance frequency — sweeps ${hi.toFixed(1)} → ${lo.toFixed(1)} brpm${passes > 1 ? ` × ${passes} passes (interleaved, averaged)` : ''}, ${measureSeconds}s measured (+${settleSeconds}s settle) per rate, ~${mins} min total. Audio muted during the sweep.`;
  if (tot) tot.textContent = '≈ ' + mins + ' min';
}

// Warn when the measure window can't cover a full breath at the SLOWEST rate (longest period),
// which is the binding case — the window fit needs ≥1 period (≥2 for a steady estimate).
function updateMeasureHint(rates, measureSeconds) {
  const hint = document.getElementById('measure-hint');
  if (!hint) return;
  if (!(rates.length >= 1) || !(measureSeconds > 0)) { hint.textContent = ''; hint.className = 'settings-note'; return; }
  const slowest = Math.min(...rates);
  const period = 60 / slowest;                 // seconds per breath at the slowest rate
  const breaths = measureSeconds / period;
  const need = Math.ceil(period * 2);          // recommend ≥ 2 periods
  if (breaths < 1) {
    hint.className = 'settings-note warn';
    hint.textContent = `Measure window (${measureSeconds}s) is shorter than one breath at the slowest rate (${slowest.toFixed(1)} brpm = ${period.toFixed(0)}s/breath). The fit can't resolve a cycle and will be discarded — use at least ${need}s.`;
  } else if (breaths < 2) {
    hint.className = 'settings-note warn';
    hint.textContent = `Measure window covers only ~${breaths.toFixed(1)} breaths at the slowest rate (${slowest.toFixed(1)} brpm); ≥2 breaths (${need}s) gives a steadier estimate.`;
  } else {
    hint.className = 'settings-note';
    hint.textContent = `Measure window covers ~${breaths.toFixed(1)} breaths at the slowest rate (${slowest.toFixed(1)} brpm).`;
  }
}

// Toolbar search button: tuning-fork (start) ⇄ square (stop), mirroring Record.
function setSearchButtonState(searching) {
  const btn = document.getElementById('search-start');
  btn.classList.toggle('searching', searching);
  document.getElementById('search-start-icon').style.display = searching ? 'none' : '';
  document.getElementById('search-stop-icon').style.display = searching ? '' : 'none';
  btn.setAttribute('aria-label', searching ? 'Stop resonance search' : 'Find resonance frequency');
  document.getElementById('search-cap').textContent = searching ? 'Stop' : 'Find rate';
  if (searching) btn.title = 'Stop the resonance search';
  else updateSweepDesc();   // restores the descriptive start tooltip
}

// One control to turn search off: cancel while running, otherwise dismiss the panel.
function toggleSearch() {
  if (state.search.status === 'running') cancelSearch();
  else startSearch();
}
function closeSearchPanel() {
  document.getElementById('search-panel').style.display = 'none';
}
// The panel's header button is Cancel while sweeping, Close once it's done/idle.
function setSearchHeaderButton(running) {
  const btn = document.getElementById('search-cancel');
  btn.textContent = running ? 'Cancel' : 'Close';
  btn.classList.toggle('is-close', !running);
  btn.disabled = false;
}

function startSearch() {
  if (state.search.status === 'running') return;

  // Validate: need HR data flowing
  if (!state.demoActive && state.hrLog.length < 3) {
    setStatus('Search needs HR data — connect strap or enable Demo mode', 'warn');
    return;
  }

  // Validate sweep settings from the drawer
  const sweep = readSweepSettings();
  if (sweep.rates.length < 2) {
    setStatus('Sweep needs at least 2 rates — check Sweep settings', 'warn');
    return;
  }
  const brpmSlider = document.getElementById('brpm');
  const sMin = parseFloat(brpmSlider.min), sMax = parseFloat(brpmSlider.max);
  const oor = sweep.rates.filter(r => r < sMin || r > sMax);
  if (oor.length) {
    setStatus(`Rates must be ${sMin}–${sMax} brpm — out of range: ${oor.join(', ')}`, 'warn');
    return;
  }
  if (sweep.measureSeconds < 10) {
    setStatus('Measure seconds must be at least 10', 'warn');
    return;
  }

  // Reset search state — capture the inhale fraction that's in effect now.
  // `rates` is the expanded run sequence: the rate list repeated `passes` times, interleaved
  // (whole list each pass) so replicates of a rate are spread across the session and cancel slow
  // drift. Analysis groups by uniqueRates and averages the replicates.
  const expanded = [];
  for (let p = 0; p < sweep.passes; p++) for (const r of sweep.rates) expanded.push(r);
  state.search.config = {
    rates: expanded,
    uniqueRates: sweep.rates,
    passes: sweep.passes,
    settleSeconds: sweep.settleSeconds,
    measureSeconds: sweep.measureSeconds,
    inhaleFraction: parseFloat(document.getElementById('inhale-frac').value),
  };
  // A fresh sweep (toolbar) starts a new program — reset the auto-refine counter AND the measurement
  // pool. A continuation (auto-refine / manual refine / re-run) keeps both, so earlier stages' samples
  // stay available to later analysis (more rate points + replicate pooling → tighter confidence).
  if (state.search.continuing) state.search.continuing = false;
  else { state.search.autoRemaining = sweep.refineRounds; state.search.pool = []; state.search.programStartedAt = Date.now(); }
  state.search.startedAt = Date.now();
  state.search.samples = [];
  state.search.status = 'running';
  state.search.currentStepIdx = -1;
  state.search.previousBrpm = parseFloat(document.getElementById('brpm').value);
  state.search.result = null;

  // Suspend audio (pitch glides between rates would be confusing)
  state.search.audioWasEnabled = audio.enabled;
  if (audio.enabled) {
    audio.enabled = false;
    document.getElementById('audio-toggle').checked = false;
    setAudioControlsEnabled(false);
    if (audio.active) stopAudioPacer();
  }

  // Auto-start session if not already running
  if (!state.running) startSession();

  document.getElementById('search-panel').style.display = 'block';
  document.getElementById('search-results').style.display = 'none';
  // Reset any open fit inspector from a previous run.
  state.search.detailRate = null;
  { const det = document.getElementById('search-detail'); if (det) { det.style.display = 'none'; det.innerHTML = ''; } }
  // Build sweep-progress dividers (one segment per rate) and reset the fill.
  const n = state.search.config.rates.length;
  let segHtml = '';
  for (let i = 1; i < n; i++) segHtml += `<div class="seg-div" style="left:${(i * 100 / n).toFixed(4)}%"></div>`;
  document.getElementById('search-progress-segs').innerHTML = segHtml;
  document.getElementById('search-progress-fill').style.width = '0%';
  setSearchButtonState(true);
  setSearchHeaderButton(true);
  document.getElementById('search-inhale-info').textContent =
    '@ ' + Math.round(state.search.config.inhaleFraction * 100) + '% inhale';
  // Lock breathing controls — they're being driven by the search, manual changes would invalidate samples.
  document.getElementById('brpm').disabled = true;
  document.getElementById('inhale-frac').disabled = true;
  ['set-rates', 'set-settle', 'set-measure', 'set-passes', 'set-refine-rounds'].forEach(id => document.getElementById(id).disabled = true);

  advanceSearchStep();
  state.search.uiInterval = setInterval(updateSearchUI, 200);
}

function advanceSearchStep() {
  state.search.currentStepIdx++;
  if (state.search.currentStepIdx >= state.search.config.rates.length) {
    finishSearch();
    return;
  }
  const rate = state.search.config.rates[state.search.currentStepIdx];

  // Drive the brpm slider
  const slider = document.getElementById('brpm');
  slider.value = rate.toFixed(1);
  slider.dispatchEvent(new Event('input'));

  state.search.samples.push({
    rate,
    settleStart: performance.now(),
    measureStart: null,
    measureEnd: null,
    cycleAmplitudes: [],
    rr: [],                 // raw RR beats captured during the measure phase (exported)
  });
  state.search.currentPhase = 'settling';
  state.search.phaseStartedAt = performance.now();
  scheduleSearchPhase();
}

function scheduleSearchPhase() {
  const cfg = state.search.config;
  const phaseDur = state.search.currentPhase === 'settling' ? cfg.settleSeconds : cfg.measureSeconds;
  state.search.phaseTimer = setTimeout(() => {
    if (state.search.status !== 'running') return;
    const cur = state.search.samples[state.search.currentStepIdx];
    if (state.search.currentPhase === 'settling') {
      cur.measureStart = performance.now();
      state.search.currentPhase = 'measuring';
      state.search.phaseStartedAt = performance.now();
      scheduleSearchPhase();
    } else {
      cur.measureEnd = performance.now();
      computeSampleStats(cur);
      cur.pass = (state.search.config.rates.slice(0, state.search.currentStepIdx + 1).filter(r => r === cur.rate).length);
      if (cur.n > 0) state.search.pool.push(cur);   // accumulate into the program-wide pool
      renderSearchBars();
      advanceSearchStep();
    }
  }, phaseDur * 1000);
}

function cancelSearch() {
  if (state.search.status !== 'running') return;
  if (state.search.phaseTimer) clearTimeout(state.search.phaseTimer);
  if (state.search.uiInterval) clearInterval(state.search.uiInterval);
  state.search.status = 'cancelled';
  state.search.autoRemaining = 0;   // stop the auto-refine program

  // Restore previous brpm
  const slider = document.getElementById('brpm');
  slider.value = state.search.previousBrpm.toFixed(1);
  slider.dispatchEvent(new Event('input'));

  restoreAudioAfterSearch();
  setSearchButtonState(false);
  setSearchHeaderButton(false);   // header button becomes Close — dismiss the panel when ready
  setStatus('Search cancelled', 'warn');
}

// Set the breathing rate (the practice/default rate) and persist it so it survives reloads.
const BRPM_KEY = 'hrv:brpm';
function applyPracticeRate(rate, reveal) {
  const slider = document.getElementById('brpm');
  slider.value = Number(rate).toFixed(1);
  slider.dispatchEvent(new Event('input'));
  try { localStorage.setItem(BRPM_KEY, slider.value); } catch (_) {}
  if (reveal) {
    const drawer = document.getElementById('breathing-drawer');
    if (drawer) drawer.open = true;
    const row = document.getElementById('brpm-row');
    if (row) { row.classList.remove('flash-highlight'); void row.offsetWidth; row.classList.add('flash-highlight'); }
  }
  setStatus(`Practice rate set to ${slider.value} brpm`, 'ok');
}

function finishSearch() {
  if (state.search.uiInterval) clearInterval(state.search.uiInterval);
  state.search.status = 'done';
  document.getElementById('search-progress-fill').style.width = '100%';
  // Analyze the whole accumulated pool (every stage), not just this sweep.
  const results = runAnalyzers(aggregateByRate(state.search.pool), state.search.analyzers);
  state.search.results = results;
  // Primary = vertex-peak when it found a real interior peak, else the best measured rate.
  const vertex = results.find(r => r.analyzerId === 'vertex-peak');
  const argmax = results.find(r => r.analyzerId === 'argmax');
  const primary = (vertex && vertex.confidence !== 'edge' && vertex.bestRate != null) ? vertex : (argmax || results[0] || null);
  // result.bestRate drives the bar highlight, so use the discrete (sampled) rate there.
  state.search.result = primary ? { bestRate: primary.discreteRate ?? primary.bestRate, confidence: primary.confidence } : { bestRate: null };
  renderSearchResults(results, primary);
  restoreAudioAfterSearch();
  setSearchButtonState(false);
  setSearchHeaderButton(false);   // header button becomes Close — dismiss the panel when ready

  // Refine: suggest a narrower sweep around this peak, but always hand it to the user for
  // confirm/override in a popup before anything runs — no unattended drilling. Offer it only while
  // rounds remain, a peak exists, and the grid can still get finer. The prominence-vs-scatter test
  // (Fix #2) sets the popup's *recommendation*: a peak that clears the per-rate scatter
  // ('clear'/'moderate') recommends refining; a peak lost in the scatter recommends stopping. That
  // recommendation is what halts the noise-chasing 5.0→4.4 walk — unless the user overrides on purpose.
  const prevRates = state.search.config.uniqueRates || state.search.config.rates;
  const finerPossible = medianGap(prevRates) / 2 >= 0.1 - 1e-9;
  if (state.search.autoRemaining > 0 && primary && primary.bestRate != null && finerPossible) {
    const trusted = primary.confidence === 'clear' || primary.confidence === 'moderate';
    promptRefine(primary, refineRates(prevRates, primary.bestRate), trusted);
    return;
  }
  // Final (or only) round: apply the interpolated result as the practice rate.
  if (primary && primary.bestRate != null) applyPracticeRate(primary.bestRate, true);
  else setStatus('Resonance search complete', 'ok');
}

// Show the refine-suggestion popup: pre-fill the narrower rate list, let the user edit it, and only
// kick off the next sweep on confirm. `trusted` (peak clears the per-rate scatter) drives which
// action is recommended/focused; the user can always override either way. The actual decision is
// handled by the dialog's close listener (wired once, below).
function promptRefine(primary, suggested, trusted) {
  state.search.primary = primary;   // stash for the close handler (apply-on-stop / decimals)
  document.getElementById('refine-dialog-rates').value = suggested.map(r => r.toFixed(1)).join(', ');
  const peak = primary.bestRate.toFixed(primary.bestRate % 1 ? 2 : 1);
  const msg = document.getElementById('refine-dialog-msg');
  if (trusted) {
    msg.textContent = `Peak at ${peak} brpm stands clear of the per-rate scatter — a finer sweep around it should sharpen the estimate.`;
    msg.className = 'refine-note';
  } else {
    msg.textContent = `Peak at ${peak} brpm sits within the per-rate scatter, so refining may only chase noise (the estimate can walk downhill across rounds). Recommended: stop here — or override the rates below to drill in anyway.`;
    msg.className = 'refine-note warn';
  }
  const startBtn = document.getElementById('refine-dialog-start');
  const stopBtn = document.getElementById('refine-dialog-stop');
  startBtn.classList.toggle('primary', trusted);
  stopBtn.classList.toggle('primary', !trusted);
  const dlg = document.getElementById('refine-dialog');
  dlg.showModal();
  (trusted ? startBtn : stopBtn).focus();
}

// Wire the refine popup once. Start → seed the (possibly edited) rates and continue the program;
// Stop / Esc → end the program and apply the best rate found so far. Neither path touches any
// amplitude/score: the popup only decides whether to collect another round.
(function wireRefineDialog() {
  const dlg = document.getElementById('refine-dialog');
  let choice = 'stop';
  document.getElementById('refine-dialog-start').addEventListener('click', () => { choice = 'start'; dlg.close(); });
  document.getElementById('refine-dialog-stop').addEventListener('click', () => { choice = 'stop'; dlg.close(); });
  dlg.addEventListener('cancel', () => { choice = 'stop'; });   // Esc
  dlg.addEventListener('close', () => {
    if (choice === 'start') {
      document.getElementById('set-rates').value = document.getElementById('refine-dialog-rates').value;
      updateSweepDesc();
      state.search.autoRemaining = Math.max(0, state.search.autoRemaining - 1);
      state.search.continuing = true;
      if (state.search.status !== 'running') startSearch();
    } else {
      state.search.autoRemaining = 0;
      const p = state.search.primary;
      if (p && p.bestRate != null) applyPracticeRate(p.bestRate, true);
      else setStatus('Resonance search complete', 'ok');
    }
    choice = 'stop';
  });
})();

// Median consecutive gap of a rate list (the current sweep spacing).
function medianGap(rates) {
  const sorted = [...rates].sort((a, b) => a - b), gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps.length ? gaps[gaps.length >> 1] : 0;
}

function restoreAudioAfterSearch() {
  if (state.search.audioWasEnabled) {
    audio.enabled = true;
    document.getElementById('audio-toggle').checked = true;
    setAudioControlsEnabled(true);
    if (state.running) startAudioPacer();
  }
  document.getElementById('brpm').disabled = false;
  document.getElementById('inhale-frac').disabled = false;
  ['set-rates', 'set-settle', 'set-measure', 'set-passes', 'set-refine-rounds'].forEach(id => document.getElementById(id).disabled = false);
}

function computeSampleStats(s) {
  const amps = s.cycleAmplitudes;
  s.n = amps.length;
  if (amps.length === 0) {
    s.median = s.mean = s.max = s.min = 0;
  } else {
    const sorted = [...amps].sort((a, b) => a - b);
    s.median = sorted[Math.floor(sorted.length / 2)];
    s.mean = amps.reduce((a, b) => a + b, 0) / amps.length;
    s.max = sorted[sorted.length - 1];
    s.min = sorted[0];
  }

  // Primary metric: ONE drift-corrected sinusoid fit over the full measure window of beats,
  // rather than the median of per-cycle (one-period-window) amplitudes. The per-cycle fit
  // inflated slow rates two ways — its window grows as the rate drops, and over a single
  // period it can't tell breathing apart from slower drift. Fitting the whole window with a
  // quadratic detrend fixes both: the window is the same duration for every rate, and the
  // t² term soaks up the curved baseline that used to leak into the amplitude.
  s.windowAmp = null;
  s.r2 = null;
  const beats = runPipeline(s.rr || [], measurementStages(), { brpm: s.rate, now: 0, windowMs: 0 }).signal;
  if (beats.length >= 6) {
    const w = 2 * Math.PI * (s.rate / 60);
    const series = beats.map(p => ({ t: p.t, v: p.rr }));
    s.windowAmp = fitPeakToTrough(series, w, 2);
    // Fit quality (coherence proxy): how much of the detrended swing is actually at the breathing
    // frequency. Used to down-weight noisy windows when pooling and to gate the confidence label.
    s.r2 = fitR2(series, w, 2);
  }
  // Score used for ranking and the final bar value — window fit when valid, else fall back
  // to the per-cycle median so a beat-starved sample still reports something.
  s.score = (s.windowAmp != null && s.windowAmp > 0) ? s.windowAmp : s.median;
}

const score = s => (s.score != null ? s.score : s.median);   // drift-corrected window fit per rate
const rateSE = s => {                                         // SE of the per-cycle amplitudes
  const ca = s.cycleAmplitudes || [];
  if (ca.length < 2) return null;
  const m = ca.reduce((a, b) => a + b, 0) / ca.length;
  const sd = Math.sqrt(ca.reduce((a, b) => a + (b - m) ** 2, 0) / (ca.length - 1));
  return sd / Math.sqrt(ca.length);
};

// Fit-quality (R²) gate. Observed separation on real data: clean RSA windows score 0.7–0.83, noisy
// ones 0.2–0.46. Windows below R2_LO contribute ~nothing to a pooled rate; 'clear' confidence needs
// the peak window at/above R2_HI. (Tunable; not exposed as a control yet.)
const R2_LO = 0.35, R2_HI = 0.65;
const r2weight = r2 => (r2 == null ? 0 : Math.max(0, Math.min(1, (r2 - R2_LO) / (R2_HI - R2_LO))));
const qualOf = s => (s.qual != null ? s.qual : (s.r2 != null ? s.r2 : null));
// Downgrade a prominence/lift-based confidence by fit quality: a prominent peak built on a noisy
// window isn't trustworthy. clear needs qual≥R2_HI; below R2_LO it caps at 'low'.
function gateByQuality(conf, qual) {
  if (qual == null) return conf;
  if (qual < R2_LO) return 'low';
  if (conf === 'clear' && qual < R2_HI) return 'moderate';
  return conf;
}

// Analyzers are composable "searches" over the swept samples — a registry like FILTERS. Each
// returns { bestRate, discreteRate, confidence, text } (discreteRate = a sampled rate, for the bar
// highlight; bestRate may be interpolated). state.search.analyzers picks which ones run.
const ANALYZERS = {
  // Pick the single highest-scoring measured rate.
  'argmax': {
    id: 'argmax',
    label: 'Best measured rate',
    analyze(samples) {
      const valid = samples.filter(s => s.n > 0);
      if (!valid.length) return null;
      const best = valid.reduce((a, b) => score(a) > score(b) ? a : b);
      const others = valid.filter(s => s !== best);
      const om = others.length ? others.reduce((a, b) => a + score(b), 0) / others.length : 0;
      const lift = om > 0 ? (score(best) - om) / om : 0;
      const q = qualOf(best);
      const confidence = gateByQuality(lift > 0.15 ? 'clear' : lift > 0.05 ? 'moderate' : 'inconclusive', q);
      return {
        bestRate: best.rate, discreteRate: best.rate, confidence,
        text: `Highest measured amplitude at <strong>${best.rate.toFixed(1)} brpm</strong> (${score(best).toFixed(0)} ms`
          + (om > 0 ? `, ~${Math.round(lift * 100)}% over the mean of the other rates` : '') + ')'
          + (q != null ? ` Fit quality R² ${q.toFixed(2)}.` : '.'),
      };
    },
  },
  // Interpolate the resonance peak: fit a parabola through the three rates around the max and take
  // the vertex — pins the peak between sampled rates. Confidence from peak prominence vs scatter.
  'vertex-peak': {
    id: 'vertex-peak',
    label: 'Interpolated resonance peak',
    analyze(samples) {
      const valid = samples.filter(s => s.n > 0).slice().sort((a, b) => a.rate - b.rate);
      if (valid.length < 3) return null;
      const ys = valid.map(score);
      let i = 0; for (let k = 1; k < ys.length; k++) if (ys[k] > ys[i]) i = k;
      if (i === 0 || i === valid.length - 1) {
        return { bestRate: valid[i].rate, discreteRate: valid[i].rate, confidence: 'edge',
          text: `Peak is at the edge of the sweep (${valid[i].rate.toFixed(1)} brpm) — extend the range to bracket it.` };
      }
      const x1 = valid[i - 1].rate, x2 = valid[i].rate, x3 = valid[i + 1].rate;
      const y1 = ys[i - 1], y2 = ys[i], y3 = ys[i + 1];
      const denom = (x1 - x2) * (x1 - x3) * (x2 - x3);
      const A = (x3 * (y2 - y1) + x2 * (y1 - y3) + x1 * (y3 - y2)) / denom;
      if (!(A < 0)) return { bestRate: x2, discreteRate: x2, confidence: 'low', text: `No concave peak; using ${x2.toFixed(1)} brpm.` };
      const B = (x3 * x3 * (y1 - y2) + x2 * x2 * (y3 - y1) + x1 * x1 * (y2 - y3)) / denom;
      const vertex = -B / (2 * A);
      const prom = y2 - (y1 + y3) / 2;                    // peak prominence
      const se = rateSE(valid[i]) || 0;
      const q = qualOf(valid[i]);
      const confidence = gateByQuality(prom > 2 * se ? 'clear' : prom > se ? 'moderate' : 'low', q);
      return {
        bestRate: vertex, discreteRate: x2, confidence,
        text: `Parabolic fit around the peak puts resonance at <strong>${vertex.toFixed(2)} brpm</strong>`
          + ` (between ${x1.toFixed(1)} and ${x3.toFixed(1)}). Prominence ${prom.toFixed(0)} ms vs ±${se.toFixed(0)} ms scatter`
          + (q != null ? `, fit quality R² ${q.toFixed(2)}.` : '.'),
      };
    },
  },
};

// Group replicate samples by rate and average, FIT-QUALITY-WEIGHTED. Interleaved passes cancel slow
// drift between rates; weighting each replicate by its R² means a noisy window (low coherence) barely
// counts, so one bad breath-hold or doze can't drag a rate down (the 4.2→{176,84} case). `qual` is the
// weighted-mean R² for the rate; `effN` the summed weight (effective replicate count).
function aggregateByRate(samples) {
  const byRate = new Map();
  for (const s of samples) {
    if (!(s.n > 0)) continue;
    if (!byRate.has(s.rate)) byRate.set(s.rate, []);
    byRate.get(s.rate).push(s);
  }
  const out = [];
  for (const [rate, reps] of byRate) {
    const usable = reps.map(r => ({ s: r.score ?? r.median, w: r2weight(r.r2), r2: r.r2 })).filter(o => o.s != null);
    if (!usable.length) continue;
    const wsum = usable.reduce((a, o) => a + o.w, 0);
    let score, qual, effN = wsum;
    if (wsum > 1e-6) {
      score = usable.reduce((a, o) => a + o.w * o.s, 0) / wsum;
      qual = usable.reduce((a, o) => a + o.w * (o.r2 ?? 0), 0) / wsum;
    } else {
      // Every window is below R2_LO — keep the least-bad one so the rate still shows, flagged low.
      const best = usable.reduce((a, b) => (b.r2 ?? 0) > (a.r2 ?? 0) ? b : a);
      score = best.s; qual = best.r2 ?? 0; effN = 0;
    }
    const cyc = reps.flatMap(r => r.cycleAmplitudes || []);
    out.push({ rate, n: cyc.length, score, median: score, qual, effN, cycleAmplitudes: cyc, replicates: reps.length });
  }
  return out.sort((a, b) => a.rate - b.rate);
}

// Coarse→fine: build a refined rate list centred on a peak, at HALF the previous spacing, spanning
// ±1 previous step each side (5 points). Rounded to the slider's 0.1 grid and clamped to range.
function refineRates(prevRates, center) {
  const sorted = [...prevRates].sort((a, b) => a - b);
  const gaps = []; for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  gaps.sort((a, b) => a - b);
  const spacing = gaps.length ? gaps[gaps.length >> 1] : 0.5;          // previous median spacing
  const step = Math.max(0.1, Math.round((spacing / 2) / 0.1) * 0.1);   // half it, on the 0.1 grid
  const slider = document.getElementById('brpm');
  const lo = parseFloat(slider.min), hi = parseFloat(slider.max);
  const out = new Set();
  for (let k = -2; k <= 2; k++) {
    const r = Math.min(hi, Math.max(lo, Math.round((center + k * step) / 0.1) * 0.1));
    out.add(r.toFixed(1));
  }
  return [...out].map(Number).sort((a, b) => b - a);   // high → low, like the default
}

// Run the selected analyzers; tag each result with its id + label.
function runAnalyzers(samples, ids) {
  return (ids || []).map(id => {
    const a = ANALYZERS[id];
    if (!a) return null;
    const r = a.analyze(samples);
    return r ? { ...r, analyzerId: id, label: a.label } : null;
  }).filter(Boolean);
}

// Init the analyzer toggles now that the ANALYZERS registry exists (avoids its temporal dead zone).
restoreAnalyzers();
renderAnalyzerControls();

// Methodology drawer: a live, plain-language description generated from the CURRENT pipeline, sweep
// settings, analyzers and R² thresholds — so it always matches what the app will actually do, rather
// than going stale like hand-written docs. Regenerated each time the drawer is opened.
const METHOD_DESC = {
  'dedup': () => `Drops the strap's notification echoes — the same RR re-reported before the next beat closes — so repeats can't bias the fit.`,
  'reject-artifacts': o => `Removes beats whose RR is more than ±${o.thresholdPct ?? 20}% off the local median (ectopic or missed beats), repeated ${o.passes ?? 3}× before the amplitude is measured.`,
  'amp-fit': o => `Draws the fitted sine + trend over the beats (window ${o.windowBreaths ?? 1} breath(s), trend order ${o.order ?? 1}) so you can watch how closely the model tracks the data — visual only, never changes the number.`,
  'mayer': o => `Marks the ~${o.freqHz ?? 0.10} Hz Mayer-wave band — the blood-pressure oscillation near 6 brpm that contaminates RSA there — visual only.`,
  'fit-envelope': o => `Draws the RSA amplitude envelope over a sliding window (${o.windowBreaths ?? 1} breath(s), overlap ${o.overlap ?? 0.5}) to show how steady the swing is — visual only.`,
};
function renderMethodology() {
  const el = document.getElementById('methodology-content');
  if (!el) return;
  const stages = state.pipeline.map(s => ({ s, f: FILTERS[s.filterId] })).filter(x => x.f);
  const on = stages.filter(x => x.s.enabled);
  const measFeed = on.filter(x => (x.f.role || 'measurement') === 'measurement' && !x.f.viz);
  const off = stages.filter(x => !x.s.enabled).map(x => x.f.label);
  const sweep = readSweepSettings();

  const stageLi = on.map(({ s, f }) => {
    const viz = !!f.viz, role = f.role || 'measurement';
    const tag = viz ? 'overlay · visual only' : role === 'measurement' ? 'feeds the score' : 'analysis overlay';
    const opts = Object.entries(s.opts || {}).map(([k, v]) => `${k} = ${v}`).join(', ');
    const desc = (METHOD_DESC[f.id] ? METHOD_DESC[f.id](s.opts || {}) : '');
    return `<li><span class="method-dot" style="background:${f.color}"></span><strong>${f.label}</strong>`
      + `<span class="method-tag">${tag}</span><span class="method-tag">min ${f.minSamples ?? 1} beats</span>`
      + `<div class="method-desc">${desc}${opts ? ` <span class="method-opts">[${opts}]</span>` : ''}</div></li>`;
  }).join('');

  const analyzers = (state.search.analyzers || []).map(id => ANALYZERS[id]).filter(Boolean);
  const anDesc = {
    'argmax': 'picks the single rate with the tallest amplitude',
    'vertex-peak': 'fits a parabola through the three rates around the tallest and takes its vertex, so the estimate can land <em>between</em> the rates you actually breathed',
  };
  const anLi = analyzers.map(a => `<li><strong>${a.label}</strong> — ${anDesc[a.id] || ''}.</li>`).join('');

  const passNote = sweep.passes > 1 ? `, ${sweep.passes} passes per rate (interleaved)` : '';
  const refineNote = sweep.refineRounds > 0
    ? `Up to <strong>${sweep.refineRounds}</strong> refine round(s) are offered: after a sweep you can confirm (or edit) a finer sweep centred on the peak — recommended only when that peak is a clean one.`
    : `Auto-refine is off — a single sweep at the rates above.`;

  el.innerHTML = `
    <p>This describes <strong>your current configuration</strong>, generated live from the pipeline and sweep settings — change a filter or a number and reopen this drawer to see it update.</p>

    <h3>1 · Signal pipeline (in order)</h3>
    <p>Every beat flows through these stages top-to-bottom. Stages marked <em>feeds the score</em> clean the beats the amplitude is measured from; <em>overlay</em> stages only draw on the graph and never change the measured number.</p>
    <ul class="method-stages">${stageLi || '<li>(no stages enabled)</li>'}</ul>
    ${off.length ? `<p class="method-off">Currently off: ${off.join(', ')}.</p>` : ''}

    <h3>2 · The amplitude (Cycle amplitude)</h3>
    <p>After cleaning, each rate's amplitude is a single <strong>least-squares sinusoid fit</strong> — a cosine + sine locked to your paced breathing frequency, plus a quadratic trend that soaks up baseline drift — fitted across the whole ${sweep.measureSeconds}s measure window. Amplitude is <code>2·√(A²+B²)</code>, reported in <strong>milliseconds of RR</strong>. One fit over the window (rather than per breath) makes it window-length-independent and resistant to any single stray beat; it needs at least 6 beats. The score is built only from the <em>feeds the score</em> stages above${measFeed.length ? ` (${measFeed.map(x => x.f.label).join(', ')})` : ''}.</p>

    <h3>3 · Fit quality (R²) — the trust gate</h3>
    <p>Each window also gets an <strong>R²</strong>: the share of the de-trended swing that actually sits at your breathing frequency. It's high when the heart-rate wave is a clean sinusoid locked to the breath (what resonance looks like) and low when the "amplitude" is really drift, Mayer waves, or a stray beat. Windows below <strong>R² ${R2_LO}</strong> barely count when repeats of a rate are averaged, and a result is only called <em>clear</em> when the peak window reaches <strong>R² ${R2_HI}</strong>. This is the coherence criterion the resonance-breathing literature uses alongside amplitude — a tall reading is only believed when the wave is clean.</p>

    <h3>4 · Finding your rate (the sweep)</h3>
    <p>Rates swept: <strong>${(sweep.rates || []).map(r => r.toFixed(1)).join(', ')}</strong> brpm. For each, a ${sweep.settleSeconds}s settle is discarded, then ${sweep.measureSeconds}s is measured${passNote}. Repeats of a rate are pooled as an <strong>R²-weighted average</strong>, so a clean window outweighs a noisy one and one bad breath-hold can't drag a rate down.</p>
    <p>The pooled rates are then read by the enabled analyzers:</p>
    <ul>${anLi || '<li>(no analyzers enabled)</li>'}</ul>
    <p>Confidence (<em>clear / moderate / low</em>) combines how far the peak stands above its neighbours' scatter with that peak's fit quality (§3). ${refineNote}</p>
  `;
}
document.getElementById('methodology-drawer').addEventListener('toggle', e => { if (e.target.open) renderMethodology(); });
renderMethodology();

function updateSearchUI() {
  if (state.search.status !== 'running') return;
  const cfg = state.search.config;
  const cur = state.search.samples[state.search.currentStepIdx];
  if (!cur) return;
  const phaseDur = state.search.currentPhase === 'settling' ? cfg.settleSeconds : cfg.measureSeconds;
  const elapsed = (performance.now() - state.search.phaseStartedAt) / 1000;
  const remaining = Math.max(0, phaseDur - elapsed);

  document.getElementById('search-current-rate').textContent = cur.rate.toFixed(1) + ' brpm';
  document.getElementById('search-phase').textContent = state.search.currentPhase;
  document.getElementById('search-step-remaining').textContent = fmtTime(remaining);

  // Total remaining = remainder of current step + all subsequent steps
  const stepsAfter = cfg.rates.length - state.search.currentStepIdx - 1;
  const currentStepRemaining = remaining + (state.search.currentPhase === 'settling' ? cfg.measureSeconds : 0);
  const totalRemaining = currentStepRemaining + stepsAfter * (cfg.settleSeconds + cfg.measureSeconds);
  document.getElementById('search-total-remaining').textContent = fmtTime(totalRemaining);

  updateSweepProgress();
  renderSearchBars();
}

// Continuous sweep progress: completed steps + elapsed fraction of the current step,
// over the whole sweep. Position lands under the rate currently measuring.
function updateSweepProgress() {
  const cfg = state.search.config;
  const stepDur = cfg.settleSeconds + cfg.measureSeconds;
  const total = (cfg.rates.length * stepDur) || 1;
  const idx = state.search.currentStepIdx;
  const cur = state.search.samples[idx];
  const stepElapsed = cur ? Math.min(stepDur, (performance.now() - cur.settleStart) / 1000) : 0;
  const elapsed = Math.max(0, idx) * stepDur + stepElapsed;
  const pct = Math.min(100, (elapsed / total) * 100);
  document.getElementById('search-progress-fill').style.width = pct.toFixed(2) + '%';
}

function fmtTime(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

function renderSearchBars() {
  const cfg = state.search.config;
  const container = document.getElementById('search-bars');
  const curSample = state.search.samples[state.search.currentStepIdx];
  // Pooled per-rate scores across ALL stages (completed), plus this sweep's rates (for live/pending).
  const pooled = new Map();   // rate -> { score, reps }
  for (const a of aggregateByRate(state.search.pool)) pooled.set(a.rate, a);
  const allRates = [...new Set([...pooled.keys(), ...(cfg.uniqueRates || cfg.rates)])].sort((a, b) => b - a);

  const completedScores = [...pooled.values()].map(a => a.score);
  const liveAmps = state.search.samples.flatMap(s => s.cycleAmplitudes);
  const peak = Math.max(50, ...completedScores, ...liveAmps);   // ms scale

  let html = '';
  for (const rate of allRates) {
    const agg = pooled.get(rate);                               // completed, pooled across stages
    const isCurrent = state.search.status === 'running' && curSample && curSample.rate === rate;
    const done = !!agg;
    let val = null;
    if (agg) {
      val = agg.score;
    } else if (isCurrent && curSample.cycleAmplitudes.length) {  // live running median, this rate
      const sd = [...curSample.cycleAmplitudes].sort((a, b) => a - b); val = sd[sd.length >> 1];
    }
    const heightPct = val !== null ? Math.min(100, (val / peak) * 100) : 0;
    const cls = ['search-bar'];
    if (isCurrent) cls.push('current');
    if (done) cls.push('done', 'clickable');                    // completed → opens its fit detail
    if (agg && agg.qual != null && agg.qual < R2_LO) cls.push('lowqual');   // noisy window — de-emphasise
    if (state.search.result && state.search.result.bestRate === rate) cls.push('winner');
    if (done && state.search.detailRate != null && Math.abs(state.search.detailRate - rate) < 1e-6) cls.push('selected');
    const repTag = agg && agg.replicates > 1 ? `<div class="search-bar-reps">×${agg.replicates}</div>` : '';
    const qualTag = agg && agg.qual != null ? `<div class="search-bar-qual">R²${agg.qual.toFixed(2)}</div>` : '';
    const title = agg && agg.qual != null ? ` title="fit quality R² ${agg.qual.toFixed(2)} — click to inspect the fit"` : (done ? ' title="Click to inspect the fit"' : '');
    html += `
      <div class="${cls.join(' ')}"${title}${done ? ` data-rate="${rate}" tabindex="0" role="button" aria-label="Inspect fit for ${rate.toFixed(1)} brpm"` : ''}>
        <div class="search-bar-track">
          <div class="search-bar-fill" style="height:${heightPct}%"></div>
        </div>
        <div class="search-bar-value">${val !== null ? val.toFixed(0) : '—'}</div>
        <div class="search-bar-label">${rate.toFixed(1)}</div>
        ${repTag}
        ${qualTag}
      </div>`;
  }
  container.innerHTML = html;
}

// Map a fit-quality R² onto the same gate semantics the search uses (clear / moderate / low),
// so the readout colour matches the bars' lowqual styling and the confidence labels.
function fitQualClass(q) {
  if (q == null) return 'qual-mod';
  if (q < R2_LO) return 'qual-low';
  if (q < R2_HI) return 'qual-mod';
  return 'qual-clear';
}

// Open (or toggle closed) the fit inspector for a swept rate. Picks the highest-R² replicate of
// that rate from the program pool, re-runs the SAME measurement pipeline + global fit the score
// used (computeSampleStats), and hands it to the renderer. Pure read of stored data — never
// re-measures or changes any number.
function showFitDetail(rate) {
  const host = document.getElementById('search-detail');
  if (!host) return;
  if (state.search.detailRate != null && Math.abs(state.search.detailRate - rate) < 1e-6) {
    state.search.detailRate = null;          // clicking the open rate again closes the strip
    host.style.display = 'none';
    host.innerHTML = '';
    renderSearchBars();
    return;
  }
  state.search.detailRate = rate;
  host.style.display = 'block';
  const reps = state.search.pool.filter(s => Math.abs(s.rate - rate) < 1e-6 && (s.rr || []).length >= 1);
  if (!reps.length) {
    host.innerHTML = `<div class="fit-detail-head"><span class="fit-detail-title">Fit · <strong>${rate.toFixed(1)} brpm</strong></span></div>`
      + `<p class="settings-note">No raw beats were captured for this rate.</p>`;
    renderSearchBars();
    return;
  }
  const sample = reps.reduce((a, b) => ((b.r2 ?? -1) > (a.r2 ?? -1) ? b : a));   // best-quality replicate
  const cleaned = runPipeline(sample.rr, measurementStages(), { brpm: rate, now: 0, windowMs: 0 }).signal;
  const w = 2 * Math.PI * (rate / 60);
  const model = cleaned.length >= 6 ? fitModel(cleaned.map(p => ({ t: p.t, v: p.rr })), w, 2) : null;
  renderFitDetail(host, rate, sample, cleaned, model, reps.length);
  renderSearchBars();   // refresh the selected-bar highlight
}

// Draw the inspector: cleaned beats (dots), the polynomial trend the fit removes (dashed), the
// fitted trend+sine model (solid), and a caliper in the gutter whose length IS the reported
// amplitude — the number shown geometrically against the beats. SVG so the reveal is pure CSS.
function renderFitDetail(host, rate, sample, cleaned, model, totalReps) {
  const amp = sample.windowAmp;   // the official score's amplitude (null if the fit was rejected)
  const r2 = sample.r2;
  const n = sample.n ?? (sample.cycleAmplitudes || []).length;
  const repNote = totalReps > 1 ? ` · best of ${totalReps} passes` : '';
  const head = `<div class="fit-detail-head">`
    + `<span class="fit-detail-title">Fit · <strong>${rate.toFixed(1)} brpm</strong>${repNote}</span>`
    + `<span class="fit-readout"><span class="k">amplitude</span>${amp != null ? amp.toFixed(0) + ' ms' : '— (rejected)'}</span>`
    + `<span class="fit-readout"><span class="k">R²</span><span class="fit-r2 ${fitQualClass(r2)}">${r2 != null ? r2.toFixed(2) : '—'}</span></span>`
    + `<span class="fit-readout"><span class="k">cycles</span>${n}</span>`
    + `</div>`;

  if (!model || cleaned.length < 6) {
    host.innerHTML = head + `<p class="settings-note">Not enough clean beats to draw a fit (need ≥ 6).</p>`;
    return;
  }

  const W = 640, H = 220, padL = 58, padR = 14, padT = 16, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const t0 = cleaned[0].t, t1 = cleaned[cleaned.length - 1].t;
  const span = Math.max(1, t1 - t0);

  let vMin = Infinity, vMax = -Infinity;
  const see = v => { if (v < vMin) vMin = v; if (v > vMax) vMax = v; };
  for (const p of cleaned) see(p.rr);
  for (const p of model.model) see(p.v);
  const center = model.model.reduce((a, p) => a + p.v, 0) / model.model.length;
  if (amp != null) { see(center + amp / 2); see(center - amp / 2); }
  const padV = Math.max(2, (vMax - vMin) * 0.12);
  vMin -= padV; vMax += padV;

  const xOf = t => padL + ((t - t0) / span) * plotW;
  const yOf = v => padT + (1 - (v - vMin) / (vMax - vMin)) * plotH;
  const pathOf = pts => pts.map((p, i) => (i ? 'L' : 'M') + xOf(p.t).toFixed(1) + ' ' + yOf(p.v).toFixed(1)).join(' ');

  const beats = cleaned.map(p => `<circle class="fit-beat" cx="${xOf(p.t).toFixed(1)}" cy="${yOf(p.rr).toFixed(1)}" r="2"/>`).join('');
  const trend = `<path class="fit-path fit-trend" d="${pathOf(model.trend)}"/>`;
  const fit = `<path class="fit-path fit-model" pathLength="1" d="${pathOf(model.model)}"/>`;

  let caliper = '';
  if (amp != null) {
    const cx = 26, yT = yOf(center + amp / 2), yB = yOf(center - amp / 2);
    caliper = `<g class="fit-caliper">`
      + `<line x1="${cx}" y1="${yT.toFixed(1)}" x2="${cx}" y2="${yB.toFixed(1)}"/>`
      + `<line x1="${cx - 4}" y1="${yT.toFixed(1)}" x2="${cx + 4}" y2="${yT.toFixed(1)}"/>`
      + `<line x1="${cx - 4}" y1="${yB.toFixed(1)}" x2="${cx + 4}" y2="${yB.toFixed(1)}"/>`
      + `<text class="fit-cal-label" x="${cx}" y="${(yT - 6).toFixed(1)}" text-anchor="middle">${amp.toFixed(0)} ms</text>`
      + `</g>`;
  }

  const axis = `<text class="fit-axis" x="4" y="12">ms</text>`
    + `<text class="fit-axis" x="${padL}" y="${H - 8}">0 s</text>`
    + `<text class="fit-axis" x="${W - padR}" y="${H - 8}" text-anchor="end">${(span / 1000).toFixed(0)} s</text>`;

  const svg = `<svg class="fit-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fitted RSA oscillation at ${rate.toFixed(1)} brpm, amplitude ${amp != null ? amp.toFixed(0) + ' milliseconds' : 'rejected'}">`
    + axis + beats + trend + fit + caliper + `</svg>`;

  const legend = `<div class="fit-legend">`
    + `<span><i style="border-color:var(--accent)"></i>cleaned beats</span>`
    + `<span><i style="border-color:#a78bfa;border-top-style:dashed"></i>trend (removed)</span>`
    + `<span><i style="border-color:#fb7185"></i>fit (trend + breath sine)</span>`
    + `</div>`;

  host.innerHTML = head + svg + legend;
}

function renderSearchResults(results, primary) {
  const el = document.getElementById('search-results');
  if (!results || !results.length || !primary || primary.bestRate == null) {
    el.innerHTML = `<div class="search-result-text">Search ended without enough data to recommend a rate.</div>`;
    el.style.display = 'block';
    return;
  }
  const conf = { clear: 'Clear.', moderate: 'Moderate.', inconclusive: 'Rates are close — worth re-running.', low: 'Low confidence.', edge: 'At the sweep edge.' }[primary.confidence] || '';
  const decimals = primary.bestRate % 1 ? 2 : 1;
  const lines = results.map(r => `<div class="search-result-text"><strong>${r.label}:</strong> ${r.text}</div>`).join('');
  el.innerHTML = `
    <div class="search-result-title">Recommended rate: <span class="search-result-rate">${primary.bestRate.toFixed(decimals)} brpm</span> <span class="search-result-conf">${conf}</span></div>
    ${lines}
    <div class="search-result-actions">
      <button id="search-apply">Set as my practice rate</button>
      <button id="search-refine">Refine around peak</button>
      <button id="search-export">Export session (JSON)</button>
      <button id="search-rerun">Re-run</button>
    </div>
  `;
  el.style.display = 'block';

  document.getElementById('search-apply').addEventListener('click', () => applyPracticeRate(primary.bestRate, true));
  document.getElementById('search-export').addEventListener('click', exportSearchSession);
  // Re-run pools another pass of the same rates into the program (more replicates → tighter).
  document.getElementById('search-rerun').addEventListener('click', () => { state.search.continuing = true; startSearch(); });
  // Second-order search: suggest a narrower, finer sweep centred on this peak via the same popup
  // (editable before it runs); the pool is kept so the coarse stage's measurements still count.
  document.getElementById('search-refine').addEventListener('click', () => {
    const prev = state.search.config.uniqueRates || state.search.config.rates;
    const trusted = primary.confidence === 'clear' || primary.confidence === 'moderate';
    if (state.search.autoRemaining < 1) state.search.autoRemaining = 1;   // allow this user-initiated round
    promptRefine(primary, refineRates(prev, primary.bestRate), trusted);
  });
  renderSearchBars();
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportSearchSession() {
  // Export the whole program's pool (every stage), so the analysis is reproducible — each sample
  // carries its rate, pass, and raw beats. Falls back to the current sweep if the pool is empty.
  const samples = (state.search.pool.length ? state.search.pool : state.search.samples).map(serializeSample);
  const startedAt = state.search.programStartedAt || state.search.startedAt;
  downloadJSON({
    startedAt: new Date(startedAt).toISOString(),
    config: state.search.config,
    pipeline: pipelineSnapshot(),
    samples,
    result: state.search.result,
    analyses: state.search.results,   // each composable analyzer's result (argmax, vertex-peak, …)
  }, `hrv-resonance-${new Date(startedAt).toISOString().replace(/[:.]/g,'-')}.json`);
}

//
// Session summary
//
function showSessionSummary() {
  const amps = state.sessionAmps;
  const summaryEl = document.getElementById('summary');
  if (amps.length < 2) { summaryEl.style.display = 'none'; return; }
  const peak = Math.max(...amps);
  const avg = amps.reduce((a,b) => a+b, 0) / amps.length;
  const threshold = peak * 0.7;
  const inBand = amps.filter(a => a >= threshold).length;
  const inBandPct = (inBand / amps.length) * 100;
  const elapsedS = Math.floor((performance.now() - state.sessionStart) / 1000);
  const mm = Math.floor(elapsedS / 60), ss = (elapsedS % 60).toString().padStart(2, '0');
  summaryEl.innerHTML = `
    <div class="summary-title">Session summary</div>
    <div class="summary-grid">
      <div><span class="summary-label">Duration</span><span class="summary-value">${mm}:${ss}</span></div>
      <div><span class="summary-label">Breaths</span><span class="summary-value">${amps.length}</span></div>
      <div><span class="summary-label">Peak amplitude</span><span class="summary-value">${peak.toFixed(0)}<small> ms</small></span></div>
      <div><span class="summary-label">Avg amplitude</span><span class="summary-value">${avg.toFixed(0)}<small> ms</small></span></div>
      <div><span class="summary-label">In-band time</span><span class="summary-value">${inBandPct.toFixed(0)}<small>%</small></span></div>
    </div>
    <div class="summary-foot">In-band = cycles with amplitude ≥ 70% of session peak.</div>
  `;
  summaryEl.style.display = 'block';
}
document.getElementById('brpm').addEventListener('input', e => {
  document.getElementById('brpm-display').textContent = parseFloat(e.target.value).toFixed(1);
});
// Persist the rate on manual commit so the last-used rate is the default next session.
document.getElementById('brpm').addEventListener('change', e => {
  try { localStorage.setItem(BRPM_KEY, parseFloat(e.target.value).toFixed(1)); } catch (_) {}
});
(function restoreBrpm() {
  try {
    const slider = document.getElementById('brpm');
    const saved = parseFloat(localStorage.getItem(BRPM_KEY));
    if (!isNaN(saved) && saved >= parseFloat(slider.min) && saved <= parseFloat(slider.max)) {
      slider.value = saved.toFixed(1);
      slider.dispatchEvent(new Event('input'));
    }
  } catch (_) {}
})();
document.getElementById('inhale-frac').addEventListener('input', e => {
  document.getElementById('inhale-display').textContent = Math.round(parseFloat(e.target.value) * 100);
});
['set-rates', 'set-settle', 'set-measure', 'set-passes', 'set-refine-rounds'].forEach(id =>
  document.getElementById(id).addEventListener('input', updateSweepDesc));
updateSweepDesc();

function setStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls || '';
}

//
// Auto-reload (dev only) — enabled by ?dev in the URL.
// Polls HEAD every 1s, compares Last-Modified / ETag, reloads on change.
// Requires HTTP serving; file:// does not return useful headers.
//
if (new URLSearchParams(location.search).has('dev')) {
  (async function autoReload() {
    let lastFingerprint = null;
    const url = location.pathname;
    const interval = 1000;
    while (true) {
      try {
        const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        const fp = res.headers.get('Last-Modified') || res.headers.get('ETag');
        if (fp) {
          if (lastFingerprint && fp !== lastFingerprint) {
            console.log('[auto-reload] file changed, reloading');
            location.reload();
            return;
          }
          lastFingerprint = fp;
        }
      } catch (_) { /* network blip, ignore */ }
      await new Promise(r => setTimeout(r, interval));
    }
  })();
  console.log('[auto-reload] enabled (?dev) — polling Last-Modified every 1s');
  const tag = document.createElement('span');
  tag.textContent = 'auto-reload on';
  tag.style.cssText = 'color:var(--warn);font-size:11px;text-transform:uppercase;letter-spacing:0.1em;margin-left:8px;';
  document.querySelector('.dev-tools').appendChild(tag);
}
