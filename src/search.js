import { state } from './state.js';
import { FILTERS, runPipeline, fitPeakToTrough, fitR2, fitModel } from './estimators-core.mjs';
import { measurementStages, pipelineSnapshot, serializeSample } from './signal.js';
import { audio, startAudioPacer, stopAudioPacer } from './feedback.js';
import { setStatus, startSession, setAudioControlsEnabled } from './app.js';
import { getInhaleFraction } from './pacer-config.js';

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
    inhaleFraction: getInhaleFraction(),
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

export { updateSweepDesc, cancelSearch, computeSampleStats, downloadJSON, BRPM_KEY };
