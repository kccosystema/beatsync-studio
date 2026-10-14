import { describe, expect, it } from "vitest";
import { generateTimeline, buildGrid } from "@/lib/engine/generate";
import { validateTimeline } from "@/lib/timeline/ops";
import { PRESET_LIST } from "@/lib/engine/presets";
import { fakeAnalysis, fakeMedia, settings } from "./fixtures";

const analysis = fakeAnalysis();
const media = fakeMedia();

describe("timeline generation", () => {
  it("is deterministic for a given seed and differs across seeds", () => {
    const a = generateTimeline({ analysis, media, settings: settings({ seed: 7 }) });
    const b = generateTimeline({ analysis, media, settings: settings({ seed: 7 }) });
    const c = generateTimeline({ analysis, media, settings: settings({ seed: 8 }) });
    expect(a.timeline).toEqual(b.timeline);
    expect(JSON.stringify(a.timeline)).not.toEqual(JSON.stringify(c.timeline));
  });

  for (const p of PRESET_LIST) {
    it(`${p.id}: contiguous, covers the song, every cut on a beat`, () => {
      const { timeline, grid } = generateTimeline({ analysis, media, settings: settings({ preset: p.id }) });
      expect(timeline.clips.length).toBeGreaterThan(3);
      expect(timeline.clips[0].start).toBe(0);
      expect(timeline.clips.at(-1)!.end).toBe(analysis.duration);
      expect(validateTimeline(timeline, media).filter((i) => !i.message.includes("held"))).toEqual([]);
      const beatSet = new Set(grid.beats);
      for (const c of timeline.clips.slice(1)) expect(beatSet.has(c.start)).toBe(true);
      // no clip uses the same media twice in a row
      timeline.clips.slice(1).forEach((c, i) => expect(c.mediaId).not.toBe(timeline.clips[i].mediaId));
    });
  }

  it("presets produce genuinely different pacing", () => {
    const count = (preset: any) => generateTimeline({ analysis, media, settings: settings({ preset }) }).timeline.clips.length;
    expect(count("edm")).toBeGreaterThan(count("cinematic") * 1.8);
    expect(count("social")).toBeGreaterThan(count("cinematic"));
  });

  it("cuts faster in the high-energy half than in the quiet half", () => {
    for (const preset of ["musicvideo", "edm", "metal"] as const) {
      const { timeline } = generateTimeline({ analysis, media, settings: settings({ preset }) });
      const avg = (from: number, to: number) => {
        const cs = timeline.clips.filter((c) => c.start >= from * 1e6 && c.start < to * 1e6);
        return cs.reduce((a, c) => a + (c.end - c.start), 0) / cs.length;
      };
      expect(avg(30, 58)).toBeLessThan(avg(0, 30));
    }
  });

  it("does not cut on every beat by default", () => {
    const { timeline } = generateTimeline({ analysis, media, settings: settings() });
    const oneBeat = timeline.clips.filter((c) => c.end - c.start <= 520_000).length;
    expect(oneBeat / timeline.clips.length).toBeLessThan(0.5);
  });

  it("cuts exactly at the drop and hits it with impact effects", () => {
    const { timeline } = generateTimeline({ analysis, media, settings: settings({ preset: "edm" }) });
    const drop = analysis.sections[1].start;
    const clip = timeline.clips.find((c) => c.start === drop)!;
    expect(clip).toBeTruthy();
    expect(clip.transitionIn.type).toBe("cut");
    expect(clip.effects.map((e) => e.type)).toEqual(expect.arrayContaining(["flash", "zoomPulse"]));
  });

  it("intensity changes cut frequency", () => {
    const n = (intensity: number) => generateTimeline({ analysis, media, settings: settings({ intensity }) }).timeline.clips.length;
    expect(n(100)).toBeGreaterThan(n(0));
  });

  it("fixed clip length setting is honoured in mid-energy material", () => {
    const { timeline } = generateTimeline({ analysis: fakeAnalysis({ dropAt: 999 }), media, settings: settings({ clipBeats: 4, preset: "social" }) });
    // all 'low' energy → 4 * 2 = 8 beats = 4 s (except the first clip which starts at 0 before beat 0, and the last)
    const videoClips = timeline.clips.slice(1, -1).filter((c) => media.find((m) => m.id === c.mediaId)!.kind === "video");
    expect(videoClips.length).toBeGreaterThan(5);
    for (const c of videoClips) expect(c.end - c.start).toBe(4_000_000);
  });

  it("transition frequency 0 gives only hard cuts; 100 gives many transitions", () => {
    const t0 = generateTimeline({ analysis, media, settings: settings({ transitionFrequency: 0 }) });
    const t100 = generateTimeline({ analysis, media, settings: settings({ transitionFrequency: 100 }) });
    expect(t0.stats.transitions).toBe(0);
    expect(t100.stats.transitions).toBeGreaterThan(3);
  });

  it("sync offset shifts every cut", () => {
    const a = generateTimeline({ analysis, media, settings: settings({ seed: 3 }) });
    const b = generateTimeline({ analysis, media, settings: settings({ seed: 3, syncOffset: 40_000 }) });
    expect(b.timeline.clips[1].start - a.timeline.clips[1].start).toBe(40_000);
  });

  it("half / double time grids", () => {
    const s = settings();
    const g1 = buildGrid(analysis, s, analysis.duration);
    const g2 = buildGrid(analysis, { ...s, tempoScale: 2 }, analysis.duration);
    const gh = buildGrid(analysis, { ...s, tempoScale: 0.5 }, analysis.duration);
    expect(g2.beats.length).toBeGreaterThan(g1.beats.length * 1.9);
    expect(gh.beats.length).toBeLessThan(g1.beats.length * 0.55);
    expect(gh.beats[1] - gh.beats[0]).toBe(1_000_000);
  });

  it("video source ranges stay inside the media", () => {
    const { timeline } = generateTimeline({ analysis, media, settings: settings({ order: "shuffle" }) });
    for (const c of timeline.clips) {
      const m = media.find((x) => x.id === c.mediaId)!;
      if (m.kind === "video") expect(c.srcIn + (c.end - c.start)).toBeLessThanOrEqual(m.duration);
      expect(c.srcIn).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles 30+ clips", () => {
    const many = fakeMedia(34, 6);
    const { timeline } = generateTimeline({ analysis, media: many, settings: settings({ preset: "edm" }) });
    expect(new Set(timeline.clips.map((c) => c.mediaId)).size).toBeGreaterThanOrEqual(30);
  });
});
