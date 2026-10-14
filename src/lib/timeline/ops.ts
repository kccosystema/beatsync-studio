/**
 * Pure timeline-editing operations. They never mutate their input and always
 * return a timeline whose clips are contiguous and cover [0, duration).
 */
import { EXCLUSIVE } from "../engine/effects";
import type { Framing, Effect, EffectType, MediaItem, Micros, Timeline, TimelineClip, Transition } from "../types";

export const MIN_CLIP: Micros = 100_000;

const len = (c: TimelineClip) => c.end - c.start;

/** Clips whose start lies in [a, b) — e.g. pulses after relayout. */
function recomputePulses(c: TimelineClip, grid: Micros[] | undefined): Micros[] {
  if (!grid) return c.pulses.filter((p) => p < len(c) - 30_000);
  const out: Micros[] = [];
  for (const b of grid) {
    if (b >= c.start - 1000 && b < c.end - 30_000) out.push(Math.max(0, b - c.start));
    if (out.length >= 32) break;
  }
  return out;
}

/** Lay clips out back-to-back from 0, fitting the last one to `duration`. */
export function relayout(clips: TimelineClip[], duration: Micros, grid?: Micros[]): TimelineClip[] {
  const out: TimelineClip[] = [];
  let t = 0;
  for (const c of clips) {
    if (t >= duration) break;
    const l = len(c);
    const end = Math.min(duration, t + l);
    out.push({ ...c, start: t, end });
    t = end;
  }
  if (out.length && t < duration) out[out.length - 1] = { ...out[out.length - 1], end: duration };
  if (out.length > 1 && len(out[out.length - 1]) < MIN_CLIP) {
    out.pop();
    out[out.length - 1] = { ...out[out.length - 1], end: duration };
  }
  return out.map((c, i) => fitTransition({ ...c, pulses: recomputePulses(c, grid) }, out[i - 1], i));
}

/** Transitions may never be longer than 90% of either neighbour. */
function fitTransition(c: TimelineClip, prev: TimelineClip | undefined, i: number): TimelineClip {
  if (i === 0 || !prev) return c.transitionIn.type === "cut" ? c : { ...c, transitionIn: { type: "cut", duration: 0 } };
  if (c.transitionIn.type === "cut") return c.transitionIn.duration ? { ...c, transitionIn: { type: "cut", duration: 0 } } : c;
  const max = Math.round(0.9 * Math.min(len(c), len(prev)));
  return c.transitionIn.duration > max ? { ...c, transitionIn: { ...c.transitionIn, duration: max } } : c;
}

export function moveClip(tl: Timeline, from: number, to: number, grid?: Micros[]): Timeline {
  if (from === to || from < 0 || from >= tl.clips.length) return tl;
  const clips = tl.clips.slice();
  const [c] = clips.splice(from, 1);
  clips.splice(Math.max(0, Math.min(clips.length, to)), 0, c);
  return { ...tl, clips: relayout(clips, tl.duration, grid) };
}

/** Remove a clip; its neighbour (previous, or next for the first clip) absorbs the gap so other cuts stay put. */
export function removeClip(tl: Timeline, index: number, grid?: Micros[]): Timeline {
  if (tl.clips.length <= 1) return { ...tl, clips: [] };
  const clips = tl.clips.slice();
  const [gone] = clips.splice(index, 1);
  if (index > 0) {
    clips[index - 1] = { ...clips[index - 1], end: gone.end };
  } else {
    const n = clips[0];
    clips[0] = { ...n, start: 0, srcIn: Math.max(0, n.srcIn - (n.start - gone.start)) };
  }
  return { ...tl, clips: relayout(clips, tl.duration, grid) };
}

let dupCounter = 0;
export function duplicateClip(tl: Timeline, index: number, grid?: Micros[]): Timeline {
  const c = tl.clips[index];
  if (!c) return tl;
  const copy: TimelineClip = { ...c, id: `${c.id}-d${Date.now().toString(36)}${dupCounter++}`, transitionIn: { type: "cut", duration: 0 } };
  const clips = tl.clips.slice();
  clips.splice(index + 1, 0, copy);
  return { ...tl, clips: relayout(clips, tl.duration, grid) };
}

/**
 * Roll edit: move the cut between clip `index-1` and `index` to `time`.
 * The incoming clip's source in-point moves with the cut so footage after the
 * cut stays where it was.
 */
export function rollCut(tl: Timeline, index: number, time: Micros, grid?: Micros[]): Timeline {
  if (index <= 0 || index >= tl.clips.length) return tl;
  const a = tl.clips[index - 1];
  const b = tl.clips[index];
  let t = Math.round(time);
  t = Math.max(a.start + MIN_CLIP, Math.min(b.end - MIN_CLIP, t));
  const delta = t - b.start;
  if (b.srcIn + delta < 0) t = b.start - b.srcIn; // can't reveal footage before the media start
  const d = t - b.start;
  const clips = tl.clips.slice();
  clips[index - 1] = { ...a, end: t };
  clips[index] = { ...b, start: t, srcIn: b.srcIn + d };
  return { ...tl, clips: relayout(clips, tl.duration, grid) };
}

export function nearestGridTime(t: Micros, grid: Micros[]): Micros {
  if (!grid.length) return t;
  let lo = 0, hi = grid.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] < t) lo = mid + 1; else hi = mid;
  }
  const c = grid[lo];
  const p = grid[lo - 1];
  return p !== undefined && Math.abs(p - t) < Math.abs(c - t) ? p : c;
}

/** Re-snap every cut to its nearest beat (used after reordering clips of uneven length). */
export function snapAllCuts(tl: Timeline, grid: Micros[]): Timeline {
  let out = tl;
  for (let i = 1; i < out.clips.length; i++) {
    const target = nearestGridTime(out.clips[i].start, grid);
    if (target !== out.clips[i].start) out = rollCut(out, i, target, grid);
  }
  return out;
}

/** Slip: change which part of the source plays without moving the clip. */
export function slipClip(tl: Timeline, index: number, srcIn: Micros, media?: MediaItem): Timeline {
  const c = tl.clips[index];
  if (!c) return tl;
  let s = Math.max(0, Math.round(srcIn));
  if (media && media.kind === "video") s = Math.min(s, Math.max(0, media.duration - len(c)));
  if (media && media.kind === "image") s = 0;
  const clips = tl.clips.slice();
  clips[index] = { ...c, srcIn: s };
  return { ...tl, clips };
}

export function setTransition(tl: Timeline, index: number, tr: Transition): Timeline {
  const c = tl.clips[index];
  if (!c || index === 0) return tl;
  const clips = tl.clips.slice();
  clips[index] = fitTransition({ ...c, transitionIn: tr.type === "cut" ? { type: "cut", duration: 0 } : tr }, clips[index - 1], index);
  return { ...tl, clips };
}

export function setEffect(tl: Timeline, index: number, type: EffectType, intensity: number | null): Timeline {
  const c = tl.clips[index];
  if (!c) return tl;
  let effects: Effect[] = c.effects.filter((e) => e.type !== type);
  if (intensity !== null) {
    const group = EXCLUSIVE.find((g) => g.includes(type));
    if (group) effects = effects.filter((e) => !group.includes(e.type));
    effects.push({ type, intensity: Math.max(0, Math.min(1, intensity)) });
  }
  const clips = tl.clips.slice();
  clips[index] = { ...c, effects };
  return { ...tl, clips };
}

export function replaceMedia(tl: Timeline, index: number, mediaId: string): Timeline {
  const c = tl.clips[index];
  if (!c) return tl;
  const clips = tl.clips.slice();
  clips[index] = { ...c, mediaId, srcIn: 0 };
  return { ...tl, clips };
}

export interface TimelineIssue {
  clipIndex: number;
  message: string;
}

/** Problems that would make preview/export differ from intent (e.g. video shorter than its slot). */
export function validateTimeline(tl: Timeline, media: MediaItem[]): TimelineIssue[] {
  const issues: TimelineIssue[] = [];
  let t = 0;
  tl.clips.forEach((c, i) => {
    if (c.start !== t) issues.push({ clipIndex: i, message: "Gap or overlap before clip" });
    t = c.end;
    const m = media.find((x) => x.id === c.mediaId);
    if (!m) { issues.push({ clipIndex: i, message: "Media missing" }); return; }
    if (m.kind === "video" && c.srcIn + len(c) > m.duration + 1000)
      issues.push({ clipIndex: i, message: "Source too short — last frame will be held" });
  });
  if (tl.clips.length && t !== tl.duration) issues.push({ clipIndex: tl.clips.length - 1, message: "Timeline does not reach the end of the song" });
  return issues;
}

/** Index of the clip under timeline time `t`. */
export function clipIndexAt(tl: Timeline, t: Micros): number {
  const cs = tl.clips;
  let lo = 0, hi = cs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < cs[mid].start) hi = mid - 1;
    else if (t >= cs[mid].end) lo = mid + 1;
    else return mid;
  }
  return t >= tl.duration ? cs.length - 1 : -1;
}

/** Remove the given effect types from every clip (used when an effect is switched off for the project). */
export function stripEffects(tl: Timeline, types: EffectType[]): Timeline {
  if (!types.length) return tl;
  let changed = false;
  const clips = tl.clips.map((c) => {
    const effects = c.effects.filter((e) => !types.includes(e.type));
    if (effects.length === c.effects.length) return c;
    changed = true;
    return { ...c, effects };
  });
  return changed ? { ...tl, clips } : tl;
}

/** Set (or clear with null) a clip's manual framing. */
export function setFraming(tl: Timeline, index: number, framing: Framing | null): Timeline {
  const c = tl.clips[index];
  if (!c) return tl;
  const clips = tl.clips.slice();
  if (!framing || (framing.x === 0 && framing.y === 0 && framing.scale === 1)) {
    if (!c.framing) return tl;
    const { framing: _drop, ...rest } = c;
    void _drop;
    clips[index] = rest;
  } else {
    clips[index] = {
      ...c,
      framing: {
        x: Math.round(Math.max(-1, Math.min(1, framing.x)) * 1000) / 1000,
        y: Math.round(Math.max(-1, Math.min(1, framing.y)) * 1000) / 1000,
        scale: Math.round(Math.max(1, Math.min(3, framing.scale)) * 1000) / 1000,
      },
    };
  }
  return { ...tl, clips };
}
