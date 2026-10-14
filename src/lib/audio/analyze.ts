/**
 * Full music analysis: beats (external Essentia result or built-in tracker),
 * downbeats, energy envelope, transients and energy-based sections.
 * Pure function — runs inside the analysis Web Worker and in unit tests.
 */
import type { BeatAnalysis, Section, SectionLabel } from "../types";
import { sec } from "../time";
import { meanStd, movingAverage, onsetEnvelope, percentile, rmsDb, waveformPeaks } from "./dsp";
import { trackBeats } from "./beatTracker";

export interface ExternalBeats {
  bpm: number;
  beats: number[]; // seconds
  confidence: number;
}

export interface AnalyzeOptions {
  /** Beats from Essentia's RhythmExtractor2013, if it ran successfully. */
  external?: ExternalBeats | null;
  onProgress?: (fraction: number, stage: string) => void;
}

export const PEAKS_PER_SECOND = 100;

export function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): BeatAnalysis {
  const progress = opts.onProgress ?? (() => {});
  const duration = samples.length / sampleRate;

  progress(0.05, "Computing onset envelope");
  const onset = onsetEnvelope(samples, sampleRate);

  progress(0.45, "Tracking beats");
  let method: BeatAnalysis["method"] = "builtin";
  let bpm: number, beatsSec: number[], confidence: number;
  if (opts.external && opts.external.beats.length >= 4) {
    method = "essentia";
    bpm = opts.external.bpm;
    beatsSec = opts.external.beats.filter((b) => b >= 0 && b < duration);
    confidence = opts.external.confidence;
  } else {
    const tracked = trackBeats(beatEnvelope(onset.flux, onset.lowFlux), onset.frameRate);
    bpm = tracked.bpm;
    beatsSec = tracked.beats.map((b) => b + onset.latency).filter((b) => b < duration);
    confidence = tracked.confidence;
  }

  progress(0.6, "Measuring energy");
  const energyHopSec = 0.05;
  const db = rmsDb(samples, Math.round(sampleRate * energyHopSec), Math.round(sampleRate * 0.4));
  const lo = percentile(db, 5), hi = percentile(db, 97);
  const energyRaw = Array.from(db, (v) => clamp01((v - lo) / Math.max(1e-6, hi - lo)));
  const energy = Array.from(movingAverage(energyRaw, 4), (v) => round3(v));

  const energyAt = (t0: number, t1: number) => {
    const a = Math.max(0, Math.floor(t0 / energyHopSec));
    const b = Math.min(energy.length, Math.max(a + 1, Math.ceil(t1 / energyHopSec)));
    let s = 0;
    for (let i = a; i < b; i++) s += energy[i];
    return s / Math.max(1, b - a);
  };
  const beatEnergy = beatsSec.map((b, i) =>
    round3(energyAt(b, beatsSec[i + 1] ?? Math.min(duration, b + 60 / Math.max(bpm, 1)))),
  );

  progress(0.7, "Estimating downbeats");
  const { indices: downbeatIndices, reliable: downbeatsReliable } = estimateDownbeats(
    beatsSec,
    onset.lowFlux,
    onset.flux,
    onset.frameRate,
    onset.latency,
  );

  progress(0.8, "Detecting transients");
  const transients = pickTransients(onset.flux, onset.frameRate).map((t) => t + onset.latency);

  progress(0.9, "Segmenting by energy");
  const sections = segmentSections(beatsSec, downbeatIndices, beatEnergy, duration);

  progress(0.94, "Measuring harmony for repeat detection");
  const beatChroma = beatSyncChroma(onset.chroma, onset.frameRate, onset.latency, beatsSec, duration);

  progress(0.97, "Building waveform");
  const peaks = waveformPeaks(samples, sampleRate, PEAKS_PER_SECOND);

  progress(1, "Done");
  return {
    method,
    bpm: Math.round(bpm * 100) / 100,
    confidence: Math.round(confidence * 1000) / 1000,
    beats: beatsSec.map(sec),
    downbeatIndices,
    downbeatsReliable,
    beatEnergy,
    energy,
    energyHop: sec(energyHopSec),
    transients: transients.map(sec),
    sections,
    peaks,
    peaksPerSecond: PEAKS_PER_SECOND,
    duration: sec(duration),
    beatChroma,
  };
}

/** Mean chroma over each beat interval, L2-normalised (silence → zeros). */
export function beatSyncChroma(chroma: Float32Array, frameRate: number, latency: number, beats: number[], duration: number): number[][] {
  const nFrames = chroma.length / 12;
  return beats.map((b, i) => {
    const end = beats[i + 1] ?? duration;
    const f0 = Math.max(0, Math.floor((b - latency) * frameRate));
    const f1 = Math.min(nFrames, Math.max(f0 + 1, Math.floor((end - latency) * frameRate)));
    const v = new Array<number>(12).fill(0);
    for (let f = f0; f < f1; f++) for (let c = 0; c < 12; c++) v[c] += chroma[f * 12 + c];
    const n = Math.hypot(...v);
    return v.map((x) => (n > 1e-9 ? Math.round((x / n) * 100) / 100 : 0));
  });
}

/**
 * Envelope for beat tracking: full-band flux plus an equally weighted
 * low-band (kick/bass) flux. Without the low band, hi-hats on 8th notes pull
 * the tracker to double time.
 */
export function beatEnvelope(flux: Float32Array, lowFlux: Float32Array): Float32Array {
  const a = meanStd(flux).std || 1;
  const b = meanStd(lowFlux).std || 1;
  const out = new Float32Array(flux.length);
  for (let i = 0; i < flux.length; i++) out[i] = flux[i] / a + (1.5 * lowFlux[i]) / b;
  return out;
}

/**
 * Picks the bar phase (beat index mod 4) whose beats carry the most low-band
 * (kick) onset energy. Marked reliable only when the winner clearly beats the
 * runner-up; otherwise the grid still starts on beat 0 but the UI says so.
 */
export function estimateDownbeats(
  beats: number[],
  lowFlux: Float32Array,
  flux: Float32Array,
  frameRate: number,
  latency = 0,
): { indices: number[]; reliable: boolean } {
  if (beats.length < 8) return { indices: beats.map((_, i) => i).filter((i) => i % 4 === 0), reliable: false };
  const strengthAt = (env: Float32Array, t: number) => {
    const f = Math.round((t - latency) * frameRate);
    let m = 0;
    for (let i = Math.max(0, f - 2); i <= Math.min(env.length - 1, f + 2); i++) m = Math.max(m, env[i]);
    return m;
  };
  const lowN = meanStd(lowFlux).std || 1;
  const fullN = meanStd(flux).std || 1;
  const scores = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  beats.forEach((b, i) => {
    const s = strengthAt(lowFlux, b) / lowN + 0.25 * (strengthAt(flux, b) / fullN);
    scores[i % 4] += s;
    counts[i % 4]++;
  });
  const avg = scores.map((s, i) => s / Math.max(1, counts[i]));
  const order = [0, 1, 2, 3].sort((a, b) => avg[b] - avg[a]);
  const phase = order[0];
  const reliable = avg[order[0]] > avg[order[1]] * 1.12;
  const indices: number[] = [];
  for (let i = phase; i < beats.length; i += 4) indices.push(i);
  return { indices, reliable };
}

export function pickTransients(flux: Float32Array, frameRate: number): number[] {
  const local = movingAverage(flux, Math.round(frameRate * 0.5));
  const { std } = meanStd(flux);
  const minGap = Math.round(frameRate * 0.08);
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 3; i < flux.length - 3; i++) {
    const v = flux[i];
    if (v < local[i] + 1.5 * std) continue;
    let isMax = true;
    for (let k = -3; k <= 3; k++) if (flux[i + k] > v) { isMax = false; break; }
    if (!isMax || i - last < minGap) continue;
    out.push(i / frameRate);
    last = i;
  }
  return out;
}

/**
 * Energy-based segmentation on bar boundaries. Labels describe energy
 * behaviour (low/mid/high, build, drop, breakdown) — we do NOT claim to know
 * which part is a "verse" or "chorus".
 */
export function segmentSections(
  beats: number[],
  downbeatIndices: number[],
  beatEnergy: number[],
  duration: number,
): Section[] {
  if (beats.length < 16) {
    const e = beatEnergy.length ? beatEnergy.reduce((a, b) => a + b, 0) / beatEnergy.length : 0;
    return [{ start: 0, end: sec(duration), label: levelLabel(e), energy: round3(e) }];
  }
  // Bars: start at each downbeat (plus a pickup bar from 0 if needed).
  const barStarts = downbeatIndices.length ? downbeatIndices.slice() : [0];
  if (barStarts[0] !== 0) barStarts.unshift(0);
  const barEnergy = barStarts.map((bi, k) => {
    const end = barStarts[k + 1] ?? beats.length;
    let s = 0;
    for (let i = bi; i < end; i++) s += beatEnergy[i];
    return s / Math.max(1, end - bi);
  });
  const nb = barEnergy.length;
  const W = 4; // bars on each side
  const novelty = barEnergy.map((_, k) => {
    if (k < 2 || k > nb - 2) return 0;
    const prev = mean(barEnergy.slice(Math.max(0, k - W), k));
    const next = mean(barEnergy.slice(k, Math.min(nb, k + W)));
    return Math.abs(next - prev);
  });
  const MIN_BARS = 4;
  const cuts: number[] = [0];
  for (let k = 2; k < nb - 1; k++) {
    if (novelty[k] < 0.12) continue;
    if (novelty[k] < novelty[k - 1] || novelty[k] < novelty[k + 1]) continue;
    if (k - cuts[cuts.length - 1] < MIN_BARS) {
      // keep the stronger of two close boundaries
      const lastK = cuts[cuts.length - 1];
      if (lastK !== 0 && novelty[k] > novelty[lastK]) cuts[cuts.length - 1] = k;
      continue;
    }
    cuts.push(k);
  }
  if (nb - cuts[cuts.length - 1] < 2 && cuts.length > 1) cuts.pop();

  const raw = cuts.map((k, i) => {
    const kEnd = cuts[i + 1] ?? nb;
    const startT = k === 0 ? 0 : beats[barStarts[k]];
    const endT = kEnd >= nb ? duration : beats[barStarts[kEnd]];
    return { start: startT, end: endT, energy: mean(barEnergy.slice(k, kEnd)) };
  });

  const labels: SectionLabel[] = raw.map((s, i) => {
    const prev = raw[i - 1];
    const next = raw[i + 1];
    const lvl = levelLabel(s.energy);
    if (lvl === "high" && prev && s.energy - prev.energy > 0.2) return "drop";
    if (lvl === "low" && prev && prev.energy - s.energy > 0.2) return i === raw.length - 1 ? "outro" : "breakdown";
    if (lvl !== "high" && next && next.energy - s.energy > 0.15 && levelLabel(next.energy) === "high") return i === 0 ? "intro" : "build";
    if (i === 0 && lvl !== "high") return "intro";
    if (i === raw.length - 1 && raw.length > 2 && lvl !== "high" && prev && prev.energy > s.energy) return "outro";
    return lvl;
  });
  return raw.map((s, i) => ({
    start: sec(s.start),
    end: sec(s.end),
    label: labels[i],
    energy: round3(s.energy),
  }));
}

function levelLabel(e: number): SectionLabel {
  return e >= 0.66 ? "high" : e < 0.4 ? "low" : "mid";
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round3 = (v: number) => Math.round(v * 1000) / 1000;
