//
// Breath subdivision config (leaf module — imports nothing, so it can't form a cycle).
//
// The breath cycle is divided into TICKS_PER_CYCLE evenly-spaced metronome ticks.
// The inhale/exhale split is chosen as an INTEGER number of those ticks (the
// #inhale-frac slider holds that integer, e.g. 4 = 4 inhale / 6 exhale). Working in
// whole ticks avoids floating-point step drift and reads more intuitively than a raw
// fraction; the rest of the app still consumes a 0–1 fraction via getInhaleFraction().
//
export const TICKS_PER_CYCLE = 10;

export function getInhaleTicks() {
  return parseInt(document.getElementById('inhale-frac').value, 10);
}

export function getInhaleFraction() {
  return getInhaleTicks() / TICKS_PER_CYCLE;
}
