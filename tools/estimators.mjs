#!/usr/bin/env node
// Cross-estimator sanity check for resonance exports. The app scores each rate with ONE estimator:
// a single-frequency least-squares sinusoid fit (windowAmp). This tool recomputes several INDEPENDENT
// estimators on the same raw RR and checks whether they agree — if they do, the rate is trustworthy;
// if they scatter, it's the data (too few breaths / off-band contamination), not the metric, and the
// honest answer is "inconclusive". Estimators:
//   1. windowAmp  — the app's single-bin sinusoid fit (baseline, imports src/estimators-core.mjs)
//   2. R2sin      — fraction of DETRENDED variance explained by that breathing-freq sinusoid
//                   (the "smooth story" / coherence proxy the app never gates on)
//   3. specPeak   — Lomb-Scargle periodogram peak: is the dominant oscillation AT the paced rate?
//   4. p2t        — peak-to-trough on a cubic-spline-resampled tachogram (Lehrer's classic estimator)
//
// Usage: node tools/estimators.mjs <export.json> [more.json ...]

import fs from 'fs';
import { runPipeline, fitPeakToTrough, solveLinear } from '../src/estimators-core.mjs';

const CLEAN = [
  { filterId: 'dedup', enabled: true, show: false, opts: {} },
  { filterId: 'reject-artifacts', enabled: true, show: false, opts: { thresholdPct: 20, passes: 3 } },
];
const cleanBeats = (beats, rate) => runPipeline(beats, CLEAN, { brpm: rate }).signal.map(p => ({ t: p.t, v: p.rr }));
const beatsOf = s => (s.beats && Array.isArray(s.beats.t)) ? s.beats.t.map((t, i) => ({ t, rr: s.beats.rr[i] }))
  : (Array.isArray(s.rr) ? s.rr.map(p => ({ t: p.t, rr: p.rr })) : []);

// --- generic least-squares fit given basis functions of centered time (seconds) ---
function lsfit(pts, basis) {
  const k = basis.length, A = Array.from({ length: k }, () => new Array(k).fill(0)), rhs = new Array(k).fill(0);
  for (const p of pts) { const phi = basis.map(f => f(p.t)); for (let j = 0; j < k; j++) { rhs[j] += phi[j] * p.v; for (let m = 0; m < k; m++) A[j][m] += phi[j] * phi[m]; } }
  const x = solveLinear(A, rhs); if (!x) return null;
  const resid = pts.reduce((s, p) => { const yh = basis.reduce((a, f, j) => a + x[j] * f(p.t), 0); return s + (p.v - yh) ** 2; }, 0);
  return { x, ssr: resid };
}
// R² of the breathing-frequency sinusoid AFTER removing a quadratic trend: how much of the non-trend
// wiggle actually sits at the paced rate. ~1 = clean resonance sinusoid; ~0 = noise dressed as a number.
function r2sin(pts, w) {
  const t0 = (pts[0].t + pts[pts.length - 1].t) / 2;
  const c = pts.map(p => ({ t: (p.t - t0) / 1000, v: p.v }));
  const trend = lsfit(c, [() => 1, t => t, t => t * t]);
  const full = lsfit(c, [t => Math.cos(w * t), t => Math.sin(w * t), () => 1, t => t, t => t * t]);
  if (!trend || !full || trend.ssr <= 0) return null;
  return Math.max(0, (trend.ssr - full.ssr) / trend.ssr);
}
// Lomb-Scargle periodogram (handles uneven beat timing natively, no resampling). Scans the
// HRV/breathing band and returns the dominant frequency in brpm + its normalized power.
function lombPeak(pts) {
  const t0 = (pts[0].t + pts[pts.length - 1].t) / 2;
  const c = pts.map(p => ({ t: (p.t - t0) / 1000, v: p.v }));
  const mean = c.reduce((s, p) => s + p.v, 0) / c.length;
  const varr = c.reduce((s, p) => s + (p.v - mean) ** 2, 0) / c.length;
  if (varr <= 0) return null;
  let best = { brpm: null, power: -1 };
  for (let f = 0.03; f <= 0.20001; f += 0.001) {           // 1.8 .. 12 brpm
    const w = 2 * Math.PI * f;
    let ss = 0, sc = 0; for (const p of c) { ss += Math.sin(2 * w * p.t); sc += Math.cos(2 * w * p.t); }
    const tau = Math.atan2(ss, sc) / (2 * w);
    let cn = 0, cd = 0, sn = 0, sd = 0;
    for (const p of c) { const co = Math.cos(w * (p.t - tau)), si = Math.sin(w * (p.t - tau)); const y = p.v - mean; cn += y * co; cd += co * co; sn += y * si; sd += si * si; }
    const P = (cn * cn / cd + sn * sn / sd) / (2 * varr);
    if (P > best.power) best = { brpm: f * 60, power: P };
  }
  return best;
}
// Natural cubic spline resample to `hz`, then peak-to-trough per breath period (Lehrer's classic).
function p2t(pts, rate, hz = 4) {
  const xs = pts.map(p => p.t / 1000), ys = pts.map(p => p.v), n = xs.length;
  if (n < 4) return null;
  const h = [], al = [0]; for (let i = 0; i < n - 1; i++) h.push(xs[i + 1] - xs[i]);
  for (let i = 1; i < n - 1; i++) al[i] = 3 / h[i] * (ys[i + 1] - ys[i]) - 3 / h[i - 1] * (ys[i] - ys[i - 1]);
  const l = [1], mu = [0], z = [0];
  for (let i = 1; i < n - 1; i++) { l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1]; mu[i] = h[i] / l[i]; z[i] = (al[i] - h[i - 1] * z[i - 1]) / l[i]; }
  l[n - 1] = 1; z[n - 1] = 0; const cc = new Array(n).fill(0), b = [], d = [];
  for (let j = n - 2; j >= 0; j--) { cc[j] = z[j] - mu[j] * cc[j + 1]; b[j] = (ys[j + 1] - ys[j]) / h[j] - h[j] * (cc[j + 1] + 2 * cc[j]) / 3; d[j] = (cc[j + 1] - cc[j]) / (3 * h[j]); }
  const evalAt = x => { let i = 0; while (i < n - 2 && x > xs[i + 1]) i++; const dx = x - xs[i]; return ys[i] + b[i] * dx + cc[i] * dx * dx + d[i] * dx * dx * dx; };
  const t0 = xs[0], t1 = xs[n - 1], step = 1 / hz, grid = [];
  for (let x = t0; x <= t1; x += step) grid.push(evalAt(x));
  const period = 60 / rate, perPts = Math.round(period * hz), amps = [];
  for (let i = 0; i + perPts <= grid.length; i += perPts) { const seg = grid.slice(i, i + perPts); amps.push(Math.max(...seg) - Math.min(...seg)); }
  if (!amps.length) return null;
  amps.sort((a, b) => a - b); return amps[amps.length >> 1];   // median breath p2t
}

function rowsFor(samples) {
  return samples.filter(s => beatsOf(s).length >= 12).map(s => {
    const cb = cleanBeats(beatsOf(s), s.rate), w = 2 * Math.PI * (s.rate / 60);
    return {
      rate: s.rate, n: cb.length,
      amp: fitPeakToTrough(cb, w, 2),
      r2: r2sin(cb, w),
      lomb: lombPeak(cb),
      p2t: p2t(cb, s.rate),
    };
  });
}
const argmaxRate = (rows, key) => { const v = rows.filter(r => key(r) != null); if (!v.length) return null; return v.reduce((a, b) => key(a) > key(b) ? a : b).rate; };

for (const file of process.argv.slice(2)) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = rowsFor(d.samples || []);
  console.log(`\n# ${file.replace(/.*\//, '')}   (stored bestRate ${d.result?.bestRate})`);
  console.log('rate  n   windowAmp   R2sin   specPeak(brpm/pow)   p2t(ms)   spec≈paced?');
  for (const r of rows.sort((a, b) => b.rate - a.rate)) {
    const near = r.lomb && Math.abs(r.lomb.brpm - r.rate) <= 0.5 ? 'yes' : 'NO';
    console.log(
      `${r.rate.toFixed(1).padStart(4)} ${String(r.n).padStart(3)}  ` +
      `${(r.amp ?? NaN).toFixed(0).padStart(7)}    ` +
      `${(r.r2 ?? NaN).toFixed(2).padStart(5)}   ` +
      `${(r.lomb?.brpm ?? NaN).toFixed(1).padStart(5)} / ${(r.lomb?.power ?? NaN).toFixed(1).padStart(4)}        ` +
      `${(r.p2t ?? NaN).toFixed(0).padStart(5)}     ${near}`);
  }
  console.log(`  argmax → windowAmp:${argmaxRate(rows, r => r.amp)}  p2t:${argmaxRate(rows, r => r.p2t)}  ` +
    `R2-weighted amp:${argmaxRate(rows, r => (r.amp ?? 0) * (r.r2 ?? 0))}  (agree ⇒ trust)`);
}
