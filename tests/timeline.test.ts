import { describe, expect, it } from "vitest";
import { generateTimeline } from "@/lib/engine/generate";
import { clipIndexAt, duplicateClip, moveClip, removeClip, rollCut, setTransition, snapAllCuts, validateTimeline } from "@/lib/timeline/ops";
import { fakeAnalysis, fakeMedia, settings } from "./fixtures";

const analysis = fakeAnalysis();
const media = fakeMedia();
const { timeline, grid } = generateTimeline({ analysis, media, settings: settings({ preset: "musicvideo", seed: 4 }) });

const contiguous = (tl: typeof timeline) => {
  expect(tl.clips[0].start).toBe(0);
  tl.clips.slice(1).forEach((c, i) => expect(c.start).toBe(tl.clips[i].end));
  expect(tl.clips.at(-1)!.end).toBe(tl.duration);
};

describe("timeline clip boundaries", () => {
  it("roll edit moves one cut and keeps footage anchored", () => {
    const b = timeline.clips[3];
    const t = rollCut(timeline, 3, b.start + 250_000);
    contiguous(t);
    expect(t.clips[2].end).toBe(b.start + 250_000);
    expect(t.clips[3].srcIn).toBe(b.srcIn + 250_000);
    expect(t.clips[5]).toEqual(timeline.clips[5]);
  });

  it("roll edit is clamped to minimum clip length", () => {
    const t = rollCut(timeline, 3, 0);
    expect(t.clips[3].start - t.clips[2].start).toBeGreaterThanOrEqual(100_000);
    contiguous(t);
  });

  it("remove lets the previous clip absorb the gap", () => {
    const t = removeClip(timeline, 4, grid.beats);
    contiguous(t);
    expect(t.clips.length).toBe(timeline.clips.length - 1);
    expect(t.clips[3].end).toBe(timeline.clips[4].end);
    expect(t.clips[4].start).toBe(timeline.clips[5].start);
  });

  it("removing the first clip keeps the timeline starting at zero", () => {
    const t = removeClip(timeline, 0, grid.beats);
    contiguous(t);
  });

  it("duplicate inserts a copy and fits to the song", () => {
    const t = duplicateClip(timeline, 2, grid.beats);
    contiguous(t);
    expect(t.clips[3].mediaId).toBe(timeline.clips[2].mediaId);
    expect(t.clips[3].id).not.toBe(timeline.clips[2].id);
  });

  it("move reorders and relays out; snapping puts cuts back on beats", () => {
    const t = moveClip(timeline, 1, 6, grid.beats);
    contiguous(t);
    expect(t.clips[6].id).toBe(timeline.clips[1].id);
    const s = snapAllCuts(t, grid.beats);
    contiguous(s);
    const beatSet = new Set(grid.beats);
    s.clips.slice(1).forEach((c) => expect(beatSet.has(c.start)).toBe(true));
    expect(validateTimeline(s, media).filter((i) => !i.message.includes("held"))).toEqual([]);
  });

  it("transitions are clamped to their neighbours", () => {
    const t = setTransition(timeline, 2, { type: "fade", duration: 60_000_000 });
    const c = t.clips[2], p = t.clips[1];
    expect(c.transitionIn.duration).toBeLessThanOrEqual(0.9 * Math.min(c.end - c.start, p.end - p.start));
  });

  it("finds the clip under the playhead at exact boundaries", () => {
    const c = timeline.clips[5];
    expect(clipIndexAt(timeline, c.start)).toBe(5);
    expect(clipIndexAt(timeline, c.start - 1)).toBe(4);
    expect(clipIndexAt(timeline, timeline.duration)).toBe(timeline.clips.length - 1);
  });
});
