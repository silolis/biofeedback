import { FILTERS, filterMinSamples, filterMinSpanSec, runPipeline, fitPeakToTrough } from './estimators-core.mjs';
import { state } from './state.js';
import { setStatus, startSession, stopSession } from './app.js';

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
function resetFitStores() { for (const k in fitStore) delete fitStore[k]; chartFit = null; }

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

export { connect, collectBeat, pruneLog, updateDerivedMetrics, computeRsa, buildInput, pipelineCtx, measurementStages, pipelineSnapshot, serializeSample, resetFitStores };
