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
  lastTickSlot: null,  // index of the metronome tick last fired this cycle
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

export { state };
