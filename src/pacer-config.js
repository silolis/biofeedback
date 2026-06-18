//
// Breath subdivision config (leaf module — imports nothing, so it can't form a cycle).
//
// The breath cycle is divided into evenly-spaced metronome ticks. The inhale/exhale
// split is chosen as whole tick counts (the #inhale-frac dropdown holds them as an
// "inhale/exhale" string, e.g. "4/6" = 4 inhale / 6 exhale). The TOTAL (inhale + exhale)
// sets how many ticks make up the cycle, so the inhale→exhale boundary always lands
// exactly on a tick. Working in whole ticks avoids floating-point step drift and reads
// more intuitively than a raw fraction; the rest of the app consumes a 0–1 fraction via
// getInhaleFraction() and the per-cycle tick count via getTicksPerCycle().
//

function getSplit() {
  // option value is "inhale/exhale", e.g. "4/6"
  const [inhale, exhale] = document.getElementById('inhale-frac').value.split('/').map(n => parseInt(n, 10));
  return { inhale, exhale };
}

export function getTicksPerCycle() {
  const { inhale, exhale } = getSplit();
  return inhale + exhale;
}

export function getInhaleFraction() {
  const { inhale, exhale } = getSplit();
  return inhale / (inhale + exhale);
}
