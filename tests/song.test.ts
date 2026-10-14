import { describe, expect, it } from "vitest";
import { analyzeAudio } from "@/lib/audio/analyze";
import { findChorus, findHighlights, sliceAnalysis, snapToBar, bestWindow } from "@/lib/audio/song";
import { generateTimeline } from "@/lib/engine/generate";
import { fakeMedia, settings } from "./fixtures";

/** V(8 bars) C(8) V C B C — chorus is louder with its own chord loop. */
function structuredSong() {
  const sr = 22050, bpm = 128, bar = (60 / bpm) * 4;
  const plan = ["V", "C", "V", "C", "B", "C"];
  const chords: Record<string, number[][]> = {
    V: [[261.6, 329.6, 392], [349.2, 440, 523.3]],
    C: [[220, 261.6, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 329.6]],
    B: [[164.8, 196, 246.9], [185, 233.1, 277.2]],
  };
  const level: Record<string, number> = { V: 0.35, C: 1, B: 0.4 };
  const seconds = plan.length * 8 * bar + 0.5;
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const sIdx = Math.min(plan.length - 1, Math.floor(t / (8 * bar)));
    const name = plan[sIdx];
    const barInSec = Math.floor((t - sIdx * 8 * bar) / bar);
    const ch = chords[name][barInSec % chords[name].length];
    let v = 0;
    for (const f of ch) v += Math.sin(2 * Math.PI * f * t) * 0.12;
    const beatT = t % (60 / bpm);
    v += Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-beatT * 40)) * beatT) * Math.exp(-beatT * 12) * 0.6;
    x[i] = v * level[name];
  }
  return { samples: x, sampleRate: sr, chorusStarts: [1, 3, 5].map((k) => k * 8 * bar), bar };
}

describe("song sections", () => {
  const song = structuredSong();
  const a = analyzeAudio(song.samples, song.sampleRate);

  it("computes per-beat chroma", () => {
    expect(a.beatChroma?.length).toBe(a.beats.length);
    expect(a.beatChroma![10]).toHaveLength(12);
  });

  it("finds the chorus: loud, repeated, starting on a chorus", () => {
    const c = findChorus(a);
    expect(c.hasChroma).toBe(true);
    expect(c.best).not.toBeNull();
    const start = c.best!.start / 1e6;
    expect(song.chorusStarts.some((t) => Math.abs(t - start) < song.bar * 0.6)).toBe(true);
    expect(c.best!.repetition).toBeGreaterThan(1);
    // its repeats are other chorus occurrences
    for (const r of c.best!.repeats) expect(song.chorusStarts.some((t) => Math.abs(t - r / 1e6) < song.bar * 0.6)).toBe(true);
    const hl = findHighlights(a);
    expect(hl[0].label).toBe("Likely chorus");
  });

  it("best-N-seconds windows are bar-aligned and land in loud material", () => {
    const w = bestWindow(a, 15)!;
    expect(w.end - w.start).toBeGreaterThan(12e6);
    const mid = (w.start + w.end) / 2e6;
    const inChorus = song.chorusStarts.some((t) => mid >= t && mid <= t + 8 * song.bar);
    expect(inChorus).toBe(true);
    expect(snapToBar(a, w.start)).toBe(w.start);
  });

  it("slicing re-bases beats, sections and peaks onto the trimmed range", () => {
    const s = 10_000_000, e = 40_000_000;
    const sl = sliceAnalysis(a, s, e);
    expect(sl.duration).toBe(30_000_000);
    expect(sl.beats[0]).toBeGreaterThanOrEqual(0);
    expect(sl.beats.at(-1)!).toBeLessThan(30_000_000);
    expect(sl.beats.length).toBe(a.beats.filter((b) => b >= s && b < e).length);
    expect(sl.beatEnergy.length).toBe(sl.beats.length);
    expect(sl.sections[0].start).toBe(0);
    expect(sl.sections.at(-1)!.end).toBe(30_000_000);
    for (const d of sl.downbeatIndices) expect(d).toBeLessThan(sl.beats.length);
    expect(Math.abs(sl.peaks.length - 30 * a.peaksPerSecond)).toBeLessThanOrEqual(1);
    expect(sliceAnalysis(a, 0, a.duration)).toBe(a); // no-op
  });

  it("an edit generated from a trimmed song covers exactly the trimmed length", () => {
    const sl = sliceAnalysis(a, 15_000_000, 45_000_000);
    const { timeline, grid } = generateTimeline({ analysis: sl, media: fakeMedia(4, 20), settings: settings() });
    expect(timeline.duration).toBe(30_000_000);
    expect(timeline.clips.at(-1)!.end).toBe(30_000_000);
    const beatSet = new Set(grid.beats);
    for (const c of timeline.clips.slice(1)) expect(beatSet.has(c.start)).toBe(true);
  });
});
