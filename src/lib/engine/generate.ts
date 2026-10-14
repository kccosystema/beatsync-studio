/**
 * Automatic editing engine.
 *
 * Deterministic: (analysis, media, settings) with the same seed always yields
 * the same timeline. Every random decision goes through one seeded Rng in a
 * fixed order.
 *
 * Steps
 *  1. Build the effective beat grid (sync offset, half/double time, grid
 *     extension to the end of the song).
 *  2. Classify every beat into an energy class from the energy sections.
 *  3. Walk the grid choosing clip lengths (in beats) from the preset rules,
 *     biased by editing intensity, snapped to bar lines and forced to cut on
 *     section changes; builds accelerate into drops.
 *  4. Assign media (sequential / shuffled, motion-aware) and source in-points
 *     with room for transition handles.
 *  5. Decide transitions per cut and effects per clip from preset rules.
 */
import type {
  BeatAnalysis,
  Effect,
  EditSettings,
  MediaItem,
  Micros,
  Section,
  Timeline,
  TimelineClip,
  Transition,
} from "../types";
import { US } from "../time";
import { Rng } from "../prng";
import { PRESETS, type EnergyClass, type Preset } from "./presets";
import { EXCLUSIVE, TIME_EFFECTS, sourceSpan, timeMap } from "./effects";

export interface BeatGrid {
  beats: Micros[];
  downbeats: Set<number>;
  energy: number[];
}

export interface GenerateInput {
  analysis: BeatAnalysis;
  media: MediaItem[];
  settings: EditSettings;
  /** Song duration (defaults to analysis.duration). */
  duration?: Micros;
}

export interface GenerateStats {
  cuts: number;
  transitions: number;
  avgClipBeats: number;
  byClass: Record<EnergyClass, number>;
}

export interface GenerateResult {
  timeline: Timeline;
  grid: BeatGrid;
  stats: GenerateStats;
}

const MIN_TRANSITION: Micros = 80_000;

export function buildGrid(analysis: BeatAnalysis, settings: EditSettings, duration: Micros): BeatGrid {
  let beats = analysis.beats.slice();
  let energy = analysis.beatEnergy.slice();
  let downs = analysis.downbeatIndices.slice();

  if (settings.tempoScale === 2) {
    const b2: Micros[] = [], e2: number[] = [];
    beats.forEach((b, i) => {
      b2.push(b); e2.push(energy[i] ?? 0);
      if (i + 1 < beats.length) { b2.push(Math.round((b + beats[i + 1]) / 2)); e2.push(energy[i] ?? 0); }
    });
    beats = b2; energy = e2; downs = downs.map((d) => d * 2);
  } else if (settings.tempoScale === 0.5) {
    const phase = downs.length ? downs[0] % 2 : 0;
    const keep: number[] = [];
    for (let i = phase; i < beats.length; i += 2) keep.push(i);
    const b2 = keep.map((i) => beats[i]);
    const e2 = keep.map((i) => ((energy[i] ?? 0) + (energy[i + 1] ?? energy[i] ?? 0)) / 2);
    const downSet = new Set(downs);
    downs = keep.map((i, k) => (downSet.has(i) ? k : -1)).filter((k) => k >= 0);
    // half-time bars are 2 grid beats apart; keep every other downbeat as bar start
    downs = downs.filter((_, k) => k % 2 === 0);
    beats = b2; energy = e2;
  }

  const offset = settings.syncOffset;
  let shifted = beats.map((b) => b + offset);
  // drop beats pushed outside the song, keeping indices consistent
  let firstValid = shifted.findIndex((b) => b >= 0);
  if (firstValid < 0) firstValid = shifted.length;
  shifted = shifted.slice(firstValid);
  energy = energy.slice(firstValid);
  downs = downs.map((d) => d - firstValid).filter((d) => d >= 0);
  const lastValid = shifted.findIndex((b) => b >= duration);
  if (lastValid >= 0) {
    shifted = shifted.slice(0, lastValid);
    energy = energy.slice(0, lastValid);
    downs = downs.filter((d) => d < lastValid);
  }

  // Extend the grid with the median period so the whole song is covered.
  if (shifted.length >= 2) {
    const ibis = shifted.slice(1).map((b, i) => b - shifted[i]).sort((a, c) => a - c);
    const period = ibis[Math.floor(ibis.length / 2)];
    const lastDown = downs.length ? downs[downs.length - 1] : 0;
    while (shifted[shifted.length - 1] + period < duration - period / 4) {
      shifted.push(shifted[shifted.length - 1] + period);
      energy.push(energy[energy.length - 1] ?? 0);
      const idx = shifted.length - 1;
      if ((idx - lastDown) % 4 === 0) downs.push(idx);
    }
  }
  return { beats: shifted, downbeats: new Set(downs), energy };
}

function sectionAt(sections: Section[], t: Micros): Section | undefined {
  for (const s of sections) if (t >= s.start && t < s.end) return s;
  return sections[sections.length - 1];
}

export function classifyBeats(grid: BeatGrid, sections: Section[], preset: Preset): EnergyClass[] {
  const out: EnergyClass[] = [];
  let lastSection: Section | undefined;
  let beatsIntoSection = 0;
  grid.beats.forEach((b, i) => {
    const s = sectionAt(sections, b);
    if (s !== lastSection) { lastSection = s; beatsIntoSection = 0; } else beatsIntoSection++;
    let c: EnergyClass;
    switch (s?.label) {
      case "drop": c = beatsIntoSection < preset.peakBars * 4 ? "peak" : "high"; break;
      case "high": c = "high"; break;
      case "mid": case "build": c = "mid"; break;
      default: c = "low";
    }
    const e = grid.energy[i] ?? 0;
    if (e >= 0.85 && (c === "low" || c === "mid")) c = c === "low" ? "mid" : "high";
    if (e < 0.15 && c !== "low") c = "low";
    out.push(c);
  });
  return out;
}

function lengthCandidates(preset: Preset, cls: EnergyClass, settings: EditSettings): { beats: number[]; weights: number[] } {
  if (settings.clipBeats) {
    const mod = cls === "low" ? 2 : cls === "peak" ? 0.5 : 1;
    return { beats: [Math.min(16, Math.max(1, settings.clipBeats * mod))], weights: [1] };
  }
  const rule = preset.lengths[cls];
  const beats = rule.beats.slice();
  const weights = rule.weights.slice();
  if (settings.intensity >= 80 && (cls === "high" || cls === "peak") && beats[0] > 1) {
    beats.unshift(beats[0] / 2); weights.unshift(weights[0] * 0.6);
  }
  if (settings.intensity <= 20 && beats[beats.length - 1] < 16) {
    beats.push(beats[beats.length - 1] * 2); weights.push(weights[weights.length - 1] * 0.6);
  }
  const bias = ((settings.intensity - 50) / 50) * 1.2;
  return { beats, weights: weights.map((w, i) => w * Math.pow(2, -bias * Math.log2(beats[i]))) };
}

function pow2Floor(v: number) {
  return Math.pow(2, Math.floor(Math.log2(Math.max(1, v))));
}

export function generateTimeline(input: GenerateInput): GenerateResult {
  const { analysis, media, settings } = input;
  const duration = input.duration ?? analysis.duration;
  const preset = PRESETS[settings.preset];
  const rng = new Rng(settings.seed);
  const grid = buildGrid(analysis, settings, duration);
  const classes = classifyBeats(grid, analysis.sections, preset);
  const { beats } = grid;
  const stats: GenerateStats = { cuts: 0, transitions: 0, avgClipBeats: 0, byClass: { low: 0, mid: 0, high: 0, peak: 0 } };

  if (!media.length || duration <= 0) {
    return { timeline: { clips: [], duration, fadeIn: 0, fadeOut: 0 }, grid, stats };
  }
  const nearestBeat = (t: Micros) => {
    let best = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - t) < Math.abs(beats[best] - t)) best = i;
    return best;
  };
  const sectionStartIdx = new Map<number, Section>();
  analysis.sections.forEach((s, k) => { if (k > 0 && beats.length) sectionStartIdx.set(nearestBeat(s.start), s); });
  const sectionEndIdx = (i: number) => {
    for (const k of [...sectionStartIdx.keys()].sort((a, b) => a - b)) if (k > i) return k;
    return beats.length;
  };
  const periodAt = (i: number) => {
    const a = beats[Math.max(0, Math.min(i, beats.length - 2))];
    const b = beats[Math.max(1, Math.min(i + 1, beats.length - 1))];
    return beats.length >= 2 ? Math.max(1, b - a) : US / 2;
  };

  // ------------------------------------------------ media picker
  const pickers = makeMediaPicker(media, settings, rng);

  const clips: TimelineClip[] = [];
  let idx = 0; // beat index the current clip ends on is chosen each loop; clip k starts at beats[idx] (clip 0 at t=0)
  let startT: Micros = 0;
  let k = 0;
  let totalBeats = 0;
  const maxTransBeats = Math.max(...Object.values(preset.transitions).map((t) => t.beats));

  while (startT < duration && k < 5000) {
    const cls = beats.length ? classes[Math.min(idx, classes.length - 1)] : "mid";
    const section = sectionAt(analysis.sections, startT);
    const isDropStart = k > 0 && sectionStartIdx.get(idx)?.label === "drop";

    // 1. clip length in beats
    const cand = lengthCandidates(preset, cls, settings);
    let L = rng.weighted(cand.beats, cand.weights);
    if (preset.accelerateBuilds && section?.label === "build") {
      L = Math.min(L, pow2Floor((sectionEndIdx(idx) - idx) / 2));
    }

    // 2. media (needs the approximate length to prefer long-enough sources)
    const approxLen = beats.length ? (beats[Math.min(beats.length - 1, idx + L)] ?? duration) - startT : duration;
    const item = pickers.next(cls, approxLen + maxTransBeats * periodAt(idx));
    if (item.kind === "image") L = Math.min(L, Math.max(1, settings.imageBeats));

    // 3. end beat: bar alignment, section boundaries
    let next = idx + Math.max(1, Math.round(L));
    if (preset.barAlign && L >= 4 && !settings.clipBeats) {
      for (const d of [next, next - 1, next + 1, next - 2, next + 2]) {
        if (d > idx + 1 && grid.downbeats.has(d)) { next = d; break; }
      }
    }
    for (const sIdx of sectionStartIdx.keys()) if (sIdx > idx && sIdx < next) next = sIdx;

    let endT: Micros = next < beats.length ? beats[next] : duration;
    const tailBeat = periodAt(Math.min(next, beats.length - 1));
    if (endT >= duration || duration - endT < tailBeat * 0.75) endT = duration;
    if (endT <= startT) endT = Math.min(duration, startT + tailBeat);

    // 4. transition into this clip
    let transitionIn: Transition = { type: "cut", duration: 0 };
    if (k > 0) {
      const rule = preset.transitions[cls];
      const p = Math.min(0.95, rule.prob * (settings.transitionFrequency / 50));
      const wantsTransition = !isDropStart && rng.chance(p);
      const type = rng.weighted(rule.types, rule.weights);
      if (wantsTransition) {
        const prev = clips[k - 1];
        const prevItem = media.find((m) => m.id === prev.mediaId)!;
        let d = Math.round(rule.beats * periodAt(idx));
        d = Math.min(d, Math.round(0.9 * Math.min(prev.end - prev.start, endT - startT)));
        if (prevItem.kind === "video") {
          const tail = prevItem.duration - (prev.srcIn + (prev.end - prev.start));
          d = Math.min(d, 2 * Math.max(0, tail));
        }
        if (d >= MIN_TRANSITION) transitionIn = { type, duration: d };
      }
    }

    // 5. effects + pulses
    const len = endT - startT;
    const pulses: Micros[] = [];
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b >= startT - 1000 && b < endT - 30_000) pulses.push(Math.max(0, b - startT));
      if (pulses.length >= 32) break;
    }
    const effects = chooseEffects(preset, cls, settings, rng, item, k, isDropStart);

    // 6. source in-point, reserving the footage time effects consume (e.g. 2× speed needs 2× the footage)
    const id = `clip-${settings.seed}-${k}`;
    const span = sourceSpan(timeMap({ id, start: startT, end: endT, srcIn: 0, effects, pulses }, item), len / 1e6);
    const need = Math.max(len, Math.round(span * 1e6));
    const srcIn = pickers.srcIn(item, need, transitionIn.duration / 2, (maxTransBeats * periodAt(idx)) / 2);

    clips.push({
      id,
      mediaId: item.id,
      srcIn,
      start: startT,
      end: endT,
      effects,
      transitionIn,
      pulses,
      section: section?.label,
    });
    stats.byClass[cls]++;
    if (transitionIn.type !== "cut") stats.transitions++;
    totalBeats += Math.max(1, next - idx);
    k++;
    idx = next;
    startT = endT;
  }

  // Fold a sub-beat final sliver into its predecessor.
  if (clips.length > 1) {
    const last = clips[clips.length - 1];
    if (last.end - last.start < periodAt(beats.length - 1) * 0.5) {
      clips.pop();
      clips[clips.length - 1].end = duration;
    }
  }

  const p0 = periodAt(0);
  const pN = periodAt(beats.length - 2);
  const timeline: Timeline = {
    clips,
    duration,
    fadeIn: Math.min(Math.round(preset.fadeInBeats * p0), clips[0] ? clips[0].end - clips[0].start : 0),
    fadeOut: Math.min(Math.round(preset.fadeOutBeats * pN), 10 * US, clips.length ? clips[clips.length - 1].end - clips[clips.length - 1].start : 0),
  };
  stats.cuts = Math.max(0, clips.length - 1);
  stats.avgClipBeats = clips.length ? Math.round((totalBeats / clips.length) * 10) / 10 : 0;
  return { timeline, grid, stats };
}

function chooseEffects(
  preset: Preset,
  cls: EnergyClass,
  settings: EditSettings,
  rng: Rng,
  item: MediaItem,
  k: number,
  isDropStart: boolean,
): Effect[] {
  const scale = settings.effectIntensity / 50;
  const out: Effect[] = [];
  const disabled = new Set(settings.disabledEffects ?? []);
  const add = (type: Effect["type"], intensity: number) => {
    if (disabled.has(type)) return;
    if (item.kind === "image" && TIME_EFFECTS.includes(type)) return; // stills have no time to remap
    const group = EXCLUSIVE.find((g) => g.includes(type));
    if (out.some((e) => e.type === type || group?.includes(e.type))) return;
    out.push({ type, intensity: Math.round(Math.min(1, Math.max(0.05, intensity)) * 100) / 100 });
  };
  for (const rule of preset.effects[cls]) {
    // always consume the same number of random draws so seeds stay stable
    const roll = rng.next();
    if (scale > 0 && roll < Math.min(0.95, rule.prob * scale)) add(rule.type, rule.intensity * (0.4 + 0.6 * scale));
  }
  if (isDropStart && preset.dropImpact && scale > 0) {
    add("flash", 0.9 * Math.min(1.2, scale));
    add("zoomPulse", 0.9 * Math.min(1.2, scale));
    add("shake", 0.6 * Math.min(1.2, scale));
  }
  if (item.kind === "image" && !out.some((e) => e.type === "zoomIn" || e.type === "zoomOut" || e.type === "zoomPulse")) {
    add(k % 2 === 0 ? "zoomIn" : "zoomOut", 0.6 * Math.max(0.5, scale));
  }
  return out;
}

function makeMediaPicker(media: MediaItem[], settings: EditSettings, rng: Rng) {
  const cursors = new Map<string, Micros>();
  let queue: MediaItem[] = [];
  let last: MediaItem | null = null;
  const refill = () => {
    let q = settings.order === "shuffle" ? rng.shuffle(media) : media.slice();
    if (q.length > 1 && last && q[0].id === last.id) q = [...q.slice(1), q[0]];
    queue = q;
  };
  const motionTarget: Record<EnergyClass, number> = { low: 0.15, mid: 0.4, high: 0.7, peak: 0.9 };

  return {
    next(cls: EnergyClass, need: Micros): MediaItem {
      if (!queue.length) refill();
      // Prefer: long enough, and (shuffle only) motion close to the energy of the music.
      let bestI = 0, bestScore = -Infinity;
      const window = settings.order === "shuffle" ? Math.min(queue.length, 4) : Math.min(queue.length, 3);
      for (let i = 0; i < window; i++) {
        const m = queue[i];
        const fits = m.kind === "image" || m.duration >= need;
        let score = (fits ? 10 : 0) - i * (settings.order === "sequential" ? 5 : 0.5);
        if (settings.order === "shuffle") score -= Math.abs((m.motion ?? 0.4) - motionTarget[cls]) * 3;
        if (m.id === last?.id && media.length > 1) score -= 20;
        if (score > bestScore) { bestScore = score; bestI = i; }
      }
      const [item] = queue.splice(bestI, 1);
      last = item;
      return item;
    },
    srcIn(item: MediaItem, len: Micros, handleIn: Micros, handleOut: Micros): Micros {
      if (item.kind === "image") return 0;
      const D = item.duration;
      const maxStart = D - len - handleOut;
      if (maxStart <= handleIn) return Math.max(0, Math.min(handleIn, D - len));
      if (settings.order === "shuffle") return Math.round(handleIn + rng.next() * (maxStart - handleIn));
      let s = Math.max(handleIn, cursors.get(item.id) ?? handleIn);
      if (s > maxStart) s = handleIn;
      cursors.set(item.id, s + len);
      return s;
    },
  };
}
