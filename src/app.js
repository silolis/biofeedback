import { state } from './state.js';
import { connect, collectBeat, pruneLog, updateDerivedMetrics, resetFitStores, serializeSample, pipelineSnapshot } from './signal.js';
import { audio, startAudioPacer, stopAudioPacer, pacerLoop, circle, label, gongTickLevels } from './feedback.js';
import { updateSweepDesc, cancelSearch, computeSampleStats, downloadJSON, BRPM_KEY } from './search.js';
import { TICKS_PER_CYCLE, getInhaleFraction } from './pacer-config.js';

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
    const inhaleFrac = getInhaleFraction();
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
      inhaleSlider.value = Math.min(parseInt(inhaleSlider.max, 10), parseInt(inhaleSlider.value, 10) + 1);
      inhaleSlider.dispatchEvent(new Event('input'));
      break;
    case 'ArrowDown':
      inhaleSlider.value = Math.max(parseInt(inhaleSlider.min, 10), parseInt(inhaleSlider.value, 10) - 1);
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
  resetFitStores();   // also clears the cached chart fit
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
  state.lastTickSlot = null;
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
  const inhaleFraction = getInhaleFraction();
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
  ['volume', 'freq-low', 'freq-high', 'mix-level']
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

document.getElementById('mix-level').addEventListener('input', (e) => {
  audio.mix = parseFloat(e.target.value);
  const { gong, tick } = gongTickLevels(audio.mix);
  document.getElementById('mix-level-display').textContent =
    `G ${Math.round(gong * 100)} · T ${Math.round(tick * 100)}`;
});


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
  // Gongs and ticks are synthesized per-hit, so the new pitch applies to the next one.
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
  const inTicks = parseInt(e.target.value, 10);
  document.getElementById('inhale-display').textContent = `${inTicks} / ${TICKS_PER_CYCLE - inTicks}`;
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

export { setStatus, startSession, stopSession, setAudioControlsEnabled };
