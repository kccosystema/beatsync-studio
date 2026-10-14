/**
 * Built-in beat tracker (fallback when Essentia.js is unavailable, and the
 * reference implementation for unit tests).
 *
 * 1. Tempo: autocorrelation of the onset envelope, weighted by a log-normal
 *    prior around 120 BPM.
 * 2. Beats: dynamic-programming beat tracking (Ellis, 2007) — chooses the beat
 *    sequence maximising onset strength while penalising deviations from the
 *    tempo period.
 */
import { meanStd, movingAverage } from "./dsp";

export interface TrackedBeats {
  bpm: number;
  /** Beat times in seconds. */
  beats: number[];
  confidence: number;
}

export function estimateTempo(
  env: Float32Array,
  frameRate: number,
  minBpm = 60,
  maxBpm = 200,
): { bpm: number; period: number; strength: number } {
  const minLag = Math.floor((60 * frameRate) / maxBpm);
  const maxLag = Math.ceil((60 * frameRate) / minBpm);
  const n = env.length;
  const { mean } = meanStd(env);
  const centred = new Float32Array(n);
  for (let i = 0; i < n; i++) centred[i] = env[i] - mean;
  let zero = 0;
  for (let i = 0; i < n; i++) zero += centred[i] * centred[i];
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += centred[i] * centred[i + lag];
    ac[lag] = s / (n - lag);
  }
  let best = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < n - 1; lag++) {
    const bpm = (60 * frameRate) / lag;
    // log-normal tempo prior centred on 120 BPM (~1 octave std dev)
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    // reward lags whose double also correlates (metrical consistency)
    const dbl = 2 * lag < ac.length ? Math.max(0, ac[2 * lag]) : 0;
    const score = (ac[lag] + 0.5 * dbl) * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  // parabolic interpolation for sub-frame precision
  let period = best;
  if (best > minLag && best < maxLag) {
    const a = ac[best - 1], b = ac[best], c = ac[best + 1];
    const d = a - 2 * b + c;
    if (d !== 0) period = best + (0.5 * (a - c)) / d;
  }
  const strength = zero > 0 ? Math.max(0, Math.min(1, (ac[best] * n) / zero)) : 0;
  return { bpm: (60 * frameRate) / period, period, strength };
}

export function trackBeats(
  env: Float32Array,
  frameRate: number,
  opts: { tightness?: number } = {},
): TrackedBeats {
  const n = env.length;
  if (n < 8) return { bpm: 0, beats: [], confidence: 0 };
  const tempo = estimateTempo(env, frameRate);
  const period = tempo.period;
  const tightness = opts.tightness ?? 100;

  // Normalise onset envelope: remove slow trend, scale by std.
  const trend = movingAverage(env, Math.round(frameRate));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = Math.max(0, env[i] - trend[i]);
  const { std } = meanStd(o);
  for (let i = 0; i < n; i++) o[i] /= std || 1;

  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0, bestIdx = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const pen = -tightness * Math.log((t - tau) / period) ** 2;
      const v = score[tau] + pen;
      if (bestIdx < 0 || v > best) { best = v; bestIdx = tau; }
    }
    score[t] = o[t] + (bestIdx >= 0 ? Math.max(0, best) : 0);
    back[t] = bestIdx >= 0 && best > 0 ? bestIdx : -1;
  }
  // Start backtrace from the best-scoring frame in the final period.
  let end = n - 1;
  let endBest = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) {
    if (score[t] > endBest) { endBest = score[t]; end = t; }
  }
  const frames: number[] = [];
  for (let t = end; t >= 0; t = back[t]) {
    frames.push(t);
    if (back[t] < 0) break;
  }
  frames.reverse();
  // Extend backwards to the start of the track along the tempo grid.
  while (frames.length && frames[0] - period > period * 0.3) {
    const guess = frames[0] - period;
    frames.unshift(refine(o, Math.round(guess), Math.round(period * 0.1)));
  }
  const beats = frames.map((f) => f / frameRate);
  const ibis = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
  const median = ibis.length ? ibis[Math.floor(ibis.length / 2)] : 60 / tempo.bpm;
  return { bpm: 60 / median, beats, confidence: tempo.strength };
}

function refine(o: Float32Array, at: number, radius: number): number {
  let best = Math.max(0, at), bv = -Infinity;
  for (let i = Math.max(0, at - radius); i <= Math.min(o.length - 1, at + radius); i++) {
    if (o[i] > bv) { bv = o[i]; best = i; }
  }
  return best;
}
