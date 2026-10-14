/**
 * Song-level tools: trimming the analysis to a section of the song, snapping
 * to bar lines, and finding highlights (likely chorus, best N seconds).
 *
 * "Likely chorus" = a bar-aligned stretch that both REPEATS elsewhere in the
 * song (chroma self-similarity along diagonals) and is LOUD relative to the
 * rest of the track. That's the textbook heuristic for pop structure; we label
 * it "likely" because it is a heuristic, not ground truth.
 */
import type { BeatAnalysis, Micros, Section } from "../types";

export interface SongRange {
  start: Micros;
  end: Micros;
}

export interface Highlight {
  id: string;
  kind: "chorus" | "section" | "best";
  label: string;
  start: Micros;
  end: Micros;
  detail: string;
  score: number;
}

/** Re-base an analysis onto [start, end): beats, energy, sections and peaks are cut and shifted so 0 = start. */
export function sliceAnalysis(a: BeatAnalysis, start: Micros, end: Micros): BeatAnalysis {
  const s = Math.max(0, Math.min(start, a.duration));
  const e = Math.max(s, Math.min(end || a.duration, a.duration));
  if (s === 0 && e === a.duration) return a;
  let i0 = a.beats.findIndex((b) => b >= s);
  if (i0 < 0) i0 = a.beats.length;
  let i1 = a.beats.findIndex((b) => b >= e);
  if (i1 < 0) i1 = a.beats.length;
  const hop = a.energyHop;
  const sections: Section[] = a.sections
    .map((x) => ({ ...x, start: Math.max(x.start, s) - s, end: Math.min(x.end, e) - s }))
    .filter((x) => x.end - x.start > 0);
  if (!sections.length) sections.push({ start: 0, end: e - s, label: "mid", energy: 0.5 });
  const pps = a.peaksPerSecond;
  return {
    ...a,
    beats: a.beats.slice(i0, i1).map((b) => b - s),
    downbeatIndices: a.downbeatIndices.filter((i) => i >= i0 && i < i1).map((i) => i - i0),
    beatEnergy: a.beatEnergy.slice(i0, i1),
    beatChroma: a.beatChroma?.slice(i0, i1),
    energy: a.energy.slice(Math.floor(s / hop), Math.ceil(e / hop)),
    transients: a.transients.filter((t) => t >= s && t < e).map((t) => t - s),
    sections,
    peaks: a.peaks.slice(Math.floor((s / 1e6) * pps), Math.ceil((e / 1e6) * pps)),
    duration: e - s,
  };
}

/** Bar-start times (downbeats), falling back to every 4th beat. */
export function barTimes(a: BeatAnalysis): Micros[] {
  if (a.downbeatIndices.length >= 2) return a.downbeatIndices.map((i) => a.beats[i]);
  return a.beats.filter((_, i) => i % 4 === 0);
}

export function snapToBar(a: BeatAnalysis, t: Micros): Micros {
  const bars = [0, ...barTimes(a), a.duration];
  let best = bars[0];
  for (const b of bars) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
  return best;
}

interface Bar {
  start: Micros;
  end: Micros;
  energy: number;
  chroma: number[] | null;
}

function bars(a: BeatAnalysis): Bar[] {
  const idx = a.downbeatIndices.length >= 2 ? a.downbeatIndices : a.beats.map((_, i) => i).filter((i) => i % 4 === 0);
  return idx.map((bi, k) => {
    const ei = idx[k + 1] ?? a.beats.length;
    let energy = 0;
    const chroma = a.beatChroma ? new Array<number>(12).fill(0) : null;
    for (let i = bi; i < ei; i++) {
      energy += a.beatEnergy[i] ?? 0;
      if (chroma && a.beatChroma?.[i]) for (let c = 0; c < 12; c++) chroma[c] += a.beatChroma[i][c];
    }
    energy /= Math.max(1, ei - bi);
    if (chroma) {
      const n = Math.hypot(...chroma);
      for (let c = 0; c < 12; c++) chroma[c] = n > 1e-9 ? chroma[c] / n : 0;
    }
    return { start: a.beats[bi], end: a.beats[ei] ?? a.duration, energy, chroma };
  });
}

const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
const fmt = (us: Micros) => {
  const t = Math.round(us / 1e6);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const SECTION_NAMES: Record<string, string> = {
  intro: "Intro", low: "Quiet section", mid: "Mid section", build: "Build-up", high: "High-energy section",
  drop: "Drop", breakdown: "Breakdown", outro: "Outro",
};

export interface ChorusResult {
  /** Best repeated loud stretch, or null when nothing repeats convincingly. */
  best: { start: Micros; end: Micros; bars: number; repeats: Micros[]; repetition: number; energy: number } | null;
  hasChroma: boolean;
}

/** Find the most chorus-like stretch: loud and repeated (8 or 16 bars). */
export function findChorus(a: BeatAnalysis): ChorusResult {
  const B = bars(a);
  const hasChroma = !!a.beatChroma && B.every((b) => b.chroma);
  if (B.length < 12) return { best: null, hasChroma };
  const nb = B.length;
  // Self-similarity, standardised so "repeats" means "more similar than typical bars".
  let simMean = 0, simSq = 0, cnt = 0;
  const sim = (i: number, j: number) => (hasChroma ? dot(B[i].chroma!, B[j].chroma!) : 0);
  if (hasChroma) {
    for (let i = 0; i < nb; i++) for (let j = i + 1; j < nb; j++) { const v = sim(i, j); simMean += v; simSq += v * v; cnt++; }
    simMean /= cnt;
  }
  const simStd = hasChroma ? Math.sqrt(Math.max(1e-9, simSq / cnt - simMean * simMean)) : 1;
  const energies = B.map((b) => b.energy);
  const eMin = Math.min(...energies), eMax = Math.max(...energies);
  const eNorm = (v: number) => (eMax - eMin > 1e-6 ? (v - eMin) / (eMax - eMin) : 0.5);
  const sectionStarts = new Set(a.sections.map((s) => s.start));

  let best: ChorusResult["best"] = null;
  let bestScore = -Infinity;
  for (const L of [8, 16]) {
    if (nb < L * 2) continue;
    for (let i = 0; i + L <= nb; i++) {
      let energy = 0;
      for (let k = 0; k < L; k++) energy += B[i + k].energy;
      energy /= L;
      let rep = 0;
      const repeats: { j: number; z: number }[] = [];
      if (hasChroma) {
        for (let j = 0; j + L <= nb; j++) {
          if (Math.abs(j - i) < L) continue; // a repeat must not overlap
          let m = 0;
          for (let k = 0; k < L; k++) m += sim(i + k, j + k);
          const z = (m / L - simMean) / simStd;
          if (z > 0.75) repeats.push({ j, z });
          rep = Math.max(rep, z);
        }
      }
      const startsSection = [...sectionStarts].some((t) => Math.abs(t - B[i].start) < 250_000);
      const score = (hasChroma ? 0.5 * eNorm(energy) + 0.5 * Math.min(1, Math.max(0, rep / 2.5)) : eNorm(energy)) + (startsSection ? 0.08 : 0) + (L === 8 ? 0.02 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = {
          start: B[i].start,
          end: B[i + L - 1].end,
          bars: L,
          repeats: repeats.sort((x, y) => y.z - x.z).map((r) => B[r.j].start).filter((t, n, arr) => arr.findIndex((u) => Math.abs(u - t) < (B[i + L - 1].end - B[i].start) / 2) === n).slice(0, 3),
          repetition: rep,
          energy,
        };
      }
    }
  }
  return { best, hasChroma };
}

/** Best bar-aligned window of ~`seconds` by mean energy. */
export function bestWindow(a: BeatAnalysis, seconds: number): SongRange | null {
  const B = bars(a);
  if (!B.length) return null;
  let best: SongRange | null = null, bestE = -Infinity;
  for (let i = 0; i < B.length; i++) {
    let j = i, e = 0;
    while (j < B.length && B[j].end - B[i].start <= seconds * 1e6 + 250_000) { e += B[j].energy * (B[j].end - B[j].start); j++; }
    if (j === i) continue;
    const span = B[j - 1].end - B[i].start;
    if (span < seconds * 1e6 * 0.8) continue;
    const mean = e / span;
    if (mean > bestE) { bestE = mean; best = { start: B[i].start, end: B[j - 1].end }; }
  }
  return best;
}

export function findHighlights(a: BeatAnalysis): Highlight[] {
  const out: Highlight[] = [];
  const ch = findChorus(a);
  if (ch.best) {
    const repeated = ch.hasChroma && ch.best.repetition > 1;
    out.push({
      id: "chorus",
      kind: "chorus",
      label: repeated ? "Likely chorus" : "Peak section",
      start: ch.best.start,
      end: ch.best.end,
      score: 1,
      detail: repeated
        ? `${ch.best.bars} bars · loud and repeats${ch.best.repeats.length ? ` at ${ch.best.repeats.map(fmt).join(", ")}` : ""}`
        : `${ch.best.bars} bars · highest energy${ch.hasChroma ? " (no strong repeat found)" : " (re-add the song to enable repeat detection)"}`,
    });
  }
  for (const secs of [15, 30, 60]) {
    if (a.duration < secs * 1.3e6) continue;
    const w = bestWindow(a, secs);
    if (w) out.push({ id: `best${secs}`, kind: "best", label: `Best ${secs} seconds`, start: w.start, end: w.end, score: 0.5, detail: "Highest-energy stretch, bar-aligned" });
  }
  a.sections.forEach((s, i) => {
    if (s.end - s.start < 4e6) return;
    out.push({
      id: `sec${i}`, kind: "section", label: SECTION_NAMES[s.label] ?? s.label, start: s.start, end: s.end, score: s.energy,
      detail: `energy ${Math.round(s.energy * 100)}%`,
    });
  });
  return out;
}
