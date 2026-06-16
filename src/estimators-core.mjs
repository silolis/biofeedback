// Resonance / RSA estimators + the signal-filter pipeline. Pure: depends only on each
// other and JS built-ins — no DOM, no app state. Shared by the app (src/app.js, bundled
// into index.html) and the offline cross-estimator check (tools/estimators.mjs). One true home.

//
// Derived metrics
//
// Solve a small linear system A x = b by Gaussian elimination with partial pivoting.
// Returns x, or null if singular.
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(row => row[n]);
}

// Drop beats whose RR deviates too far from the window median — beat-detection glitches
// (missed/extra/ectopic beats and their compensatory pauses), not real RSA. Works in
// RR/ms (symmetric for doublings/halvings, unlike a one-sided HR threshold) and iterates,
// so a skewed first median doesn't let the compensatory beat slip through.
function rejectArtifacts(beats, thresh = 0.20, maxPasses = 3) {
  if (beats.length < 5) return beats;
  let kept = beats;
  for (let iter = 0; iter < maxPasses; iter++) {
    const vals = kept.map(p => p.rr).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    if (!(med > 0)) break;
    const next = kept.filter(p => Math.abs(p.rr - med) <= thresh * med);
    if (next.length === kept.length || next.length < 5) break;
    kept = next;
  }
  return kept;
}

// Fit a·cos(wt) + b·sin(wt) + polynomial, then return the isolated oscillation a·cos+b·sin per
// sample (zero-mean) — the waveform at angular frequency w. Used to extract/visualize one band
// (e.g. the Mayer wave) independently of the breathing component.
function fitSinusoidComponent(points, w, detrendOrder = 1) {
  const nParam = 2 + (detrendOrder + 1);
  if (points.length < nParam + 1) return null;
  const tMid = (points[0].t + points[points.length - 1].t) / 2;
  const A = Array.from({ length: nParam }, () => new Array(nParam).fill(0));
  const rhs = new Array(nParam).fill(0);
  for (const p of points) {
    const t = (p.t - tMid) / 1000;
    const phi = [Math.cos(w * t), Math.sin(w * t)];
    for (let d = 0, pw = 1; d <= detrendOrder; d++, pw *= t) phi.push(pw);
    for (let j = 0; j < nParam; j++) { rhs[j] += phi[j] * p.rr; for (let k = 0; k < nParam; k++) A[j][k] += phi[j] * phi[k]; }
  }
  const x = solveLinear(A, rhs);
  if (!x) return null;
  const a = x[0], b = x[1];
  return points.map(p => { const t = (p.t - tMid) / 1000; return { t: p.t, rr: a * Math.cos(w * t) + b * Math.sin(w * t) }; });
}

// One window's amplitude-fit overlay — the base trend (polynomial the fit removes) and the model
// (trend + fitted sine). This IS the measurement fit, drawn. Returns line marks, or null.
function ampFitWindow(beats, w, opts) {
  const order = opts.order ?? 1;
  if (beats.length < 2 + (order + 1) + 1) return null;
  const m = fitModel(beats.map(p => ({ t: p.t, v: p.rr })), w, order);
  if (!m) return null;
  return [
    { kind: 'line', data: m.trend.map(p => ({ t: p.t, rr: p.v })), color: '#a78bfa' },  // base trend
    { kind: 'line', data: m.model.map(p => ({ t: p.t, rr: p.v })), color: '#fb7185' },  // trend + sine
  ];
}

// One window's RSA envelope — mean ± amp/2 drawn as a level segment over the window.
function envFitWindow(beats, w, opts) {
  if (beats.length < 5) return null;
  const amp = fitPeakToTrough(beats.map(p => ({ t: p.t, v: p.rr })), w, 1);
  if (amp == null) return null;
  const mean = beats.reduce((a, p) => a + p.rr, 0) / beats.length;
  const t0 = beats[0].t, t1 = beats[beats.length - 1].t;
  return [
    { kind: 'line', data: [{ t: t0, rr: mean + amp / 2 }, { t: t1, rr: mean + amp / 2 }], color: '#fb923c' },
    { kind: 'line', data: [{ t: t0, rr: mean - amp / 2 }, { t: t1, rr: mean - amp / 2 }], color: '#fb923c' },
  ];
}

// Tile a signal into breath-length windows (windowBreaths × 60/brpm, stepped by 1−overlap) and
// collect each window's overlay marks. Used by the export apply() (one-shot) and mirrored by the
// live store. windowBreaths defaults to 1 → the per-breath measurement fit.
function tileFit(signal, opts, ctx, fitWindowFn) {
  if (signal.length < 2) return { signal, marks: [] };
  const brpm = (ctx && ctx.brpm) || 6, w = 2 * Math.PI * (brpm / 60);
  const L = (opts.windowBreaths ?? 1) * (60000 / brpm);
  const step = Math.max(250, L * (1 - (opts.overlap ?? 0)));
  const tEnd = signal[signal.length - 1].t, marks = [];
  for (let s = Math.floor(signal[0].t / step) * step; s + L <= tEnd + 1; s += step) {
    const win = signal.filter(p => p.t >= s && p.t < s + L);
    const m = fitWindowFn(win, w, opts);
    if (m) marks.push(...m);
  }
  return { signal, marks };
}

//
// Signal filter pipeline
// ----------------------
// The signal is an array of beats [{t, rr}] (t = performance.now() ms, rr = ms).
// A filter is a plain object { id, label, color, defaults, schema, apply(signal, opts, ctx) }:
//   • apply is pure and returns { signal, marks? }.
//   • opts is opaque to the engine — stored and passed back verbatim; `schema` exists only to
//     auto-render the tweak controls (engine never interprets option values).
//   • marks are visualization primitives { kind:'points'|'line'|'band', data, style? } that the
//     graph overlays (e.g. a drop filter returns the beats it removed as points).
//   • ctx is read-only context { brpm, now, windowMs } for frequency-aware filters.
// runPipeline threads the signal through each enabled stage, recording a named tap after every
// stage so any stage output — and the marks — is an addressable source for the visualization layer.
//
const FILTERS = {
  // Collapse the strap's notification echoes: it pushes ~2 packets/s but you beat ~1/s, so each
  // completed RR is re-reported until the next beat closes — consecutive identical rr values.
  // Keep the first occurrence per beat; the repeats carry no new information.
  'dedup': {
    id: 'dedup',
    label: 'Collapse duplicate beats',
    color: 'var(--muted)',
    role: 'measurement',           // cleaning — feeds the metric/score
    minSamples: 2,                 // need a neighbour to compare against
    defaults: { maxGapFrac: 0.6 },
    schema: [
      { key: 'maxGapFrac', label: 'Echo gap (× RR)', type: 'range', min: 0.3, max: 0.9, step: 0.05 },
    ],
    // Time-aware: collapse a repeat ONLY if it arrives sooner than a real beat could — within
    // maxGapFrac × RR of the kept beat. Echoes land at the ~0.5 s notification cadence (well under
    // one RR); a genuine beat that happens to equal its neighbour lands ~1 RR later and is kept.
    apply(signal, opts) {
      const frac = opts.maxGapFrac ?? 0.6;
      const kept = [], echoes = [];
      for (const p of signal) {
        const prev = kept[kept.length - 1];
        if (prev && p.rr === prev.rr && (p.t - prev.t) < frac * p.rr) echoes.push(p);
        else kept.push(p);
      }
      return { signal: kept, marks: echoes.length ? [{ kind: 'points', data: echoes, style: { glyph: 'dot' } }] : [] };
    },
  },
  'reject-artifacts': {
    id: 'reject-artifacts',
    label: 'Artifact rejection',
    color: 'var(--warn)',
    role: 'measurement',           // cleaning — feeds the metric/score
    minSamples: 5,                 // median-based rejection needs a small population
    defaults: { thresholdPct: 20, passes: 3 },
    schema: [
      { key: 'thresholdPct', label: 'Reject beyond ±%', type: 'range', min: 5, max: 50, step: 1 },
      { key: 'passes',       label: 'Passes',           type: 'int',   min: 1, max: 5,  step: 1 },
    ],
    apply(signal, opts) {
      const kept = rejectArtifacts(signal, (opts.thresholdPct ?? 20) / 100, opts.passes ?? 3);
      const keptSet = new Set(kept);
      const dropped = signal.filter(p => !keptSet.has(p));
      return { signal: kept, marks: dropped.length ? [{ kind: 'points', data: dropped }] : [] };
    },
  },
  // Visualize the amplitude fit itself (visualization only): slide a short, configurable window,
  // and in each window run the SAME least-squares fit the metric uses — drawing its base trend
  // (the polynomial drift the fit removes) and the fitted sine (the breath-locked wave). This is
  // why there's no separate "detrend" stage: drift removal lives inside the estimator, and this
  // shows what it's doing. Pure viz — it never alters the measured signal.
  'amp-fit': {
    id: 'amp-fit',
    label: 'Amplitude fit (sine + trend)',
    color: '#a78bfa',
    role: 'analysis',                 // it doesn't transform; it VISUALIZES the measurement fit
    viz: true,
    windowed: true,                   // computed per window, frozen on completion (see fit store)
    fitWindow: ampFitWindow,
    minSamples: 6,
    minSpanSec: (opts, ctx) => (opts.windowBreaths ?? 1) * 60 / ((ctx && ctx.brpm) || 6),
    defaults: { windowBreaths: 1, overlap: 0, order: 1 },   // default = the per-breath measurement fit
    schema: [
      { key: 'windowBreaths', label: 'Window (breaths)',     type: 'range', min: 1, max: 6,   step: 1 },
      { key: 'overlap',       label: 'Overlap (fraction)',   type: 'range', min: 0, max: 0.9, step: 0.1 },
      { key: 'order',         label: 'Trend order',          type: 'int',   min: 1, max: 2,   step: 1 },
    ],
    apply(signal, opts, ctx) { return tileFit(signal, opts, ctx, ampFitWindow); },
  },
  // Extract the Mayer wave (spontaneous ~0.1 Hz blood-pressure oscillation). Show it as a line to
  // SEE the contamination — when you breathe near 6 brpm (0.1 Hz) it rides on top of the RSA, which
  // is why amplitude is unreliable there. Enabling subtracts it (useful away from 6 brpm; at 6 brpm
  // it can't be separated from breathing). Frequency-fixed, so its span need is in Mayer periods.
  'mayer': {
    id: 'mayer',
    label: 'Mayer wave (~0.1 Hz)',
    color: '#22d3ee',
    role: 'analysis',
    minSamples: 5,
    minSpanSec: opts => 2 / (opts.freqHz ?? 0.10),   // ≥2 Mayer periods (~20 s)
    defaults: { freqHz: 0.10 },
    schema: [
      { key: 'freqHz', label: 'Mayer frequency (Hz)', type: 'number', min: 0.05, max: 0.15, step: 0.005 },
    ],
    apply(signal, opts) {
      const osc = fitSinusoidComponent(signal, 2 * Math.PI * (opts.freqHz ?? 0.10), 1);
      if (!osc) return { signal };
      const mean = signal.reduce((s, p) => s + p.rr, 0) / signal.length;
      const line = osc.map(o => ({ t: o.t, rr: mean + o.rr }));            // draw at signal level
      const out = signal.map((p, i) => ({ t: p.t, rr: p.rr - osc[i].rr })); // enabled: remove Mayer
      return { signal: out, marks: [{ kind: 'line', data: line }] };
    },
  },
  // Visualization only (viz): slide a one-breath window across the signal, fit the RSA amplitude in
  // each, and draw the local mean ± amp/2 envelope. The gap between the two lines is the fitted
  // peak-to-trough at that moment, so it bulges and pinches where the amplitude varies cycle to
  // cycle — a direct read on the fit's stability (and the Mayer beating near 6 brpm).
  'fit-envelope': {
    id: 'fit-envelope',
    label: 'Fit envelope (RSA)',
    color: '#fb923c',
    role: 'analysis',
    viz: true,
    windowed: true,
    fitWindow: envFitWindow,
    minSamples: 6,
    minSpanSec: (opts, ctx) => (opts.windowBreaths ?? 1) * 60 / ((ctx && ctx.brpm) || 6),
    defaults: { windowBreaths: 1, overlap: 0.5 },
    schema: [
      { key: 'windowBreaths', label: 'Window (breaths)',   type: 'range', min: 1, max: 6,   step: 1 },
      { key: 'overlap',       label: 'Overlap (fraction)', type: 'range', min: 0, max: 0.9, step: 0.1 },
    ],
    apply(signal, opts, ctx) { return tileFit(signal, opts, ctx, envFitWindow); },
  },
};

// Resolve a filter's minimum-sample requirement (a number, or a function of its opts).
function filterMinSamples(f, opts) {
  const m = f.minSamples;
  return (typeof m === 'function' ? m(opts || {}) : m) || 0;
}

// Resolve a filter's minimum time-span requirement in seconds (number, or fn of opts + ctx).
// Frequency-aware filters use this so the threshold scales with the rate (e.g. ≥N breaths).
function filterMinSpanSec(f, opts, ctx) {
  const m = f.minSpanSec;
  return (typeof m === 'function' ? m(opts || {}, ctx || {}) : m) || 0;
}

function signalSpanSec(sig) {
  return sig.length > 1 ? (sig[sig.length - 1].t - sig[0].t) / 1000 : 0;
}

// Apply the configured stages in turn. Returns the final signal, the per-stage taps
// (named snapshots, incl. 'raw' and 'output'), and the accumulated visualization marks.
function runPipeline(input, stages, ctx, opts) {
  const marksActive = !!opts && opts.marksFor === 'active';   // export: capture marks for enabled OR shown
  let signal = input;
  const taps = [{ id: 'raw', label: 'Raw', signal }];
  const marks = [];
  for (const st of (stages || [])) {
    const f = FILTERS[st.filterId];
    if (!f) continue;
    // `enabled` applies the transform; `show` renders its marks. They're independent, so a filter
    // can visualize without adjusting (e.g. preview a baseline fit) — run apply if either is set.
    const show = st.show !== false;
    if (!st.enabled && !show) { taps.push({ id: f.id, label: f.label, signal }); continue; }
    // Starved: too few samples OR too short a span for a valid result — pass through, no marks.
    const min = filterMinSamples(f, st.opts);
    const minSpan = filterMinSpanSec(f, st.opts, ctx);
    if (signal.length < min || signalSpanSec(signal) < minSpan) {
      taps.push({ id: f.id, label: f.label, signal, starved: true, min, minSpan });
      continue;
    }
    const out = f.apply(signal, st.opts || {}, ctx) || {};
    const wantMarks = marksActive ? (st.enabled || show) : show;
    if (wantMarks) for (const m of (out.marks || [])) {
      marks.push({ ...m, filterId: f.id, color: m.color || (m.style && m.style.color) || f.color });
    }
    if (st.enabled && !f.viz && out.signal) signal = out.signal;   // viz filters never transform
    taps.push({ id: f.id, label: f.label, signal });
  }
  taps.push({ id: 'output', label: 'Output', signal });
  return { signal, taps, marks };
}

// Least-squares peak-to-trough amplitude of a {t, v} series at angular frequency w:
// fit v ≈ a·cos(ωt) + b·sin(ωt) + (polynomial detrend of degree `detrendOrder`).
// The cos/sin pair captures the breath-locked oscillation at any phase/lag; the polynomial
// absorbs the mean and slow baseline drift. Frequency-locked, so it does not grow with
// window length the way raw max−min does — rates compare fairly.
//
// detrendOrder controls how much sub-breathing drift the fit can soak up:
//   1 (default) → c + d·t   — a straight line; fine for short (one-cycle) live windows.
//   2           → c + d·t + e·t² — also removes curvature; needed for the long multi-cycle
//                 search window, where a straight line leaves curved drift (Mayer waves,
//                 baseline wander) to leak into the amplitude and inflate slow rates.
// Core solve: fit v ≈ a·cos(ωt) + b·sin(ωt) + (polynomial of degree detrendOrder).
// Returns { x: coeffs [a, b, c, d, …], tMid, vMin, vMax } or null. tMid centers t for conditioning.
function fitSinusoidPoly(series, w, detrendOrder) {
  const nParam = 2 + (detrendOrder + 1);          // cos, sin, then 1, t, …, t^detrendOrder
  if (series.length < nParam + 1) return null;
  const tMid = (series[0].t + series[series.length - 1].t) / 2;
  const A = Array.from({ length: nParam }, () => new Array(nParam).fill(0));
  const rhs = new Array(nParam).fill(0);
  let vMin = Infinity, vMax = -Infinity;
  for (const p of series) {
    const t = (p.t - tMid) / 1000;                       // seconds, centered
    const phi = [Math.cos(w * t), Math.sin(w * t)];
    for (let d = 0, pw = 1; d <= detrendOrder; d++, pw *= t) phi.push(pw);   // 1, t, t², …
    for (let j = 0; j < nParam; j++) {
      rhs[j] += phi[j] * p.v;
      for (let k = 0; k < nParam; k++) A[j][k] += phi[j] * phi[k];
    }
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  const x = solveLinear(A, rhs);
  return x ? { x, tMid, vMin, vMax } : null;
}

// Least-squares peak-to-trough amplitude at angular frequency w (frequency-locked; the polynomial
// detrend absorbs slow drift so it doesn't leak into the amplitude). detrendOrder: 1 (line) / 2 (curve).
function fitPeakToTrough(series, w, detrendOrder = 1) {
  const r = fitSinusoidPoly(series, w, detrendOrder);
  if (!r) return null;
  const amp = 2 * Math.hypot(r.x[0], r.x[1]);
  if (!isFinite(amp)) return null;
  // Sanity guard: a real oscillation captured in the window can't swing much wider than the data
  // itself. Over a sub-period window the fit can extrapolate a huge slow wave from a tiny slope.
  if (amp > 2 * (r.vMax - r.vMin)) return null;
  return amp;
}

// Fraction of the DETRENDED variance that sits at the breathing frequency w (centered seconds, like
// fitSinusoidPoly): residual SS of a trend-only polynomial fit vs a trend+sinusoid fit. ~1 = a clean
// RSA sinusoid (high HR↔breath coherence); ~0 = the fitted "amplitude" is mostly noise. This is the
// fit-quality / coherence gate — windowAmp reports a number even for junk windows; R² flags them.
function fitR2(series, w, detrendOrder = 2) {
  if (series.length < detrendOrder + 4) return null;
  const tMid = (series[0].t + series[series.length - 1].t) / 2;
  const pts = series.map(p => ({ t: (p.t - tMid) / 1000, v: p.v }));
  const ssr = (basis) => {
    const k = basis.length;
    const A = Array.from({ length: k }, () => new Array(k).fill(0)), rhs = new Array(k).fill(0);
    for (const p of pts) {
      const phi = basis.map(f => f(p.t));
      for (let j = 0; j < k; j++) { rhs[j] += phi[j] * p.v; for (let m = 0; m < k; m++) A[j][m] += phi[j] * phi[m]; }
    }
    const x = solveLinear(A, rhs);
    if (!x) return null;
    return pts.reduce((s, p) => { const yh = basis.reduce((a, f, j) => a + x[j] * f(p.t), 0); return s + (p.v - yh) ** 2; }, 0);
  };
  const poly = [];
  for (let d = 0; d <= detrendOrder; d++) { const dd = d; poly.push(t => Math.pow(t, dd)); }
  const trendSSR = ssr(poly);
  const fullSSR = ssr([t => Math.cos(w * t), t => Math.sin(w * t), ...poly]);
  if (trendSSR == null || fullSSR == null || trendSSR <= 0) return null;
  return Math.max(0, Math.min(1, (trendSSR - fullSSR) / trendSSR));
}

// Same fit, but reconstruct the model components for visualization: `trend` is the polynomial
// (the base trend the fit removes) and `model` is trend + the fitted sine (the breath-locked wave).
function fitModel(series, w, detrendOrder = 1) {
  const r = fitSinusoidPoly(series, w, detrendOrder);
  if (!r) return null;
  const { x, tMid } = r, a = x[0], b = x[1];
  const trend = [], model = [];
  for (const p of series) {
    const t = (p.t - tMid) / 1000;
    let poly = 0, pw = 1;
    for (let d = 0; d <= detrendOrder; d++, pw *= t) poly += x[2 + d] * pw;
    trend.push({ t: p.t, v: poly });
    model.push({ t: p.t, v: poly + a * Math.cos(w * t) + b * Math.sin(w * t) });
  }
  return { amp: 2 * Math.hypot(a, b), trend, model };
}

export {
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
};
