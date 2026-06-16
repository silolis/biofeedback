#!/usr/bin/env node
// Re-analyze an exported HRV JSON offline, reusing the app's own pipeline + fit functions
// (imported from src/estimators-core.mjs so they never drift). For each sample it recomputes the window
// amplitude two ways: (1) "clean" = dedup + reject only, and (2) "as-exported" = the exact stage
// config recorded in the file's `pipeline` block — so e.g. an enabled Mayer filter that gutted the
// RSA at 6 brpm is obvious.
//
// Usage:  node reanalyze.mjs <export.json>

import fs from 'fs';
import { runPipeline, fitPeakToTrough } from './src/estimators-core.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node reanalyze.mjs <export.json>'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

// Beats may be columnar { t:[], rr:[] } (current) or legacy [{t,rr}] — normalize to AoS.
function beatsOf(sample) {
  if (sample.beats && Array.isArray(sample.beats.t)) {
    return sample.beats.t.map((t, i) => ({ t, rr: sample.beats.rr[i] }));
  }
  if (Array.isArray(sample.rr)) return sample.rr.map(p => ({ t: p.t, rr: p.rr }));
  return [];
}

const CLEAN = [
  { filterId: 'dedup', enabled: true, show: false, opts: {} },
  { filterId: 'reject-artifacts', enabled: true, show: true, opts: { thresholdPct: 20, passes: 3 } },
];
const exported = Array.isArray(data.pipeline)
  ? data.pipeline.map(s => ({ filterId: s.filterId, enabled: s.enabled, show: s.show, opts: s.opts || {}, role: s.role || 'measurement' }))
  : null;
// The score is computed on measurement stages only (analysis filters are overlays). Older exports
// without roles fall back to treating the recorded pipeline as measurement.
const exportedMeas = exported ? exported.filter(s => s.role !== 'analysis') : null;

const fit = (beats, stages, rate) => {
  const out = runPipeline(beats, stages, { brpm: rate }).signal;
  const a = fitPeakToTrough(out.map(p => ({ t: p.t, v: p.rr })), 2 * Math.PI * (rate / 60), 2);
  return { n: out.length, amp: a };
};

// --- Integrity check: does the current code reproduce the saved output + marks? ---
const cols = pts => ({ t: pts.map(p => p.t), rr: pts.map(p => p.rr) });
const EPS = 1e-6;
const maxDiff = (a, b) => { let m = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const cmpCols = (stored, fresh) => ({
  lenOk: stored.t.length === fresh.t.length && stored.rr.length === fresh.rr.length,
  dt: maxDiff(stored.t, fresh.t), drr: maxDiff(stored.rr, fresh.rr),
  nS: stored.rr.length, nF: fresh.rr.length,
});
// Re-run the recorded pipeline on the saved raw beats and diff against what was stored.
// Any mismatch beyond float noise means the code changed since the export (drift).
function verifyStored(s) {
  if (!exported || !s.output || !Array.isArray(s.marks)) return null;   // nothing to verify against
  const beats = beatsOf(s);
  const measOut = runPipeline(beats, exportedMeas, { brpm: s.rate }).signal;          // score basis
  const full = runPipeline(beats, exported, { brpm: s.rate }, { marksFor: 'active' }); // overlays
  const freshMarks = full.marks.map(m => ({ filterId: m.filterId, kind: m.kind, ...cols(m.data) }));
  const issues = [];
  const o = cmpCols(s.output, cols(measOut));
  if (!o.lenOk) issues.push(`output length ${o.nS}→${o.nF}`);
  else if (o.drr > EPS || o.dt > EPS) issues.push(`output Δrr=${o.drr.toExponential(1)}`);
  if (s.marks.length !== freshMarks.length) issues.push(`marks count ${s.marks.length}→${freshMarks.length}`);
  for (let i = 0; i < Math.min(s.marks.length, freshMarks.length); i++) {
    const a = s.marks[i], b = freshMarks[i];
    if (a.filterId !== b.filterId || a.kind !== b.kind) { issues.push(`mark#${i} ${a.filterId}/${a.kind}→${b.filterId}/${b.kind}`); continue; }
    const c = cmpCols(a, b);
    if (!c.lenOk) issues.push(`${a.filterId}.${a.kind} len ${c.nS}→${c.nF}`);
    else if (c.drr > EPS || c.dt > EPS) issues.push(`${a.filterId}.${a.kind} Δrr=${c.drr.toExponential(1)}`);
  }
  return issues;
}

console.log(`# ${file}`);
if (exported) {
  const tag = s => `${s.filterId}${s.role === 'analysis' ? '(analysis)' : ''}`;
  console.log(`pipeline (enabled): ${exported.filter(s => s.enabled).map(tag).join(', ') || '(none)'}`);
  console.log(`score basis (measurement): ${exportedMeas.filter(s => s.enabled).map(s => s.filterId).join(', ') || '(none)'}`);
}
for (const s of (data.samples || [])) {
  const beats = beatsOf(s);
  const rr = beats.map(p => p.rr);
  const range = rr.length ? Math.max(...rr) - Math.min(...rr) : 0;
  const clean = fit(beats, CLEAN, s.rate);
  console.log(`\nrate ${s.rate} | beats ${beats.length} | rr range ${range.toFixed(0)} ms | stored score ${s.score?.toFixed?.(1) ?? s.score}`);
  console.log(`  clean (dedup+reject)      windowAmp: ${clean.amp == null ? 'null' : clean.amp.toFixed(1)} ms (n=${clean.n})`);
  if (exportedMeas) {
    const as = fit(beats, exportedMeas, s.rate);
    console.log(`  as-exported (measurement) windowAmp: ${as.amp == null ? 'null' : as.amp.toFixed(1)} ms (n=${as.n})`);
  }
  const drift = verifyStored(s);
  if (drift) console.log(`  verify stored vs recompute: ${drift.length ? 'DRIFT — ' + drift.join('; ') : 'PASS'}`);
}
