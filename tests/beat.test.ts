import { describe, expect, it } from "vitest";
import { analyzeAudio } from "@/lib/audio/analyze";
import { synthTrack } from "./synth";

function matchRate(detected: number[], truth: number[], tol: number) {
  let hit = 0;
  for (const t of truth) if (detected.some((d) => Math.abs(d - t) <= tol)) hit++;
  return hit / truth.length;
}

describe("beat detection (builtin tracker)", () => {
  for (const bpm of [90, 120, 128, 145]) {
    it(`finds beats of a ${bpm} BPM track within 35 ms`, () => {
      const { samples, sampleRate, beats } = synthTrack({ bpm, seconds: 30, offset: 0.37 });
      const a = analyzeAudio(samples, sampleRate);
      expect(a.method).toBe("builtin");
      expect(Math.abs(a.bpm - bpm)).toBeLessThan(1.5);
      const det = a.beats.map((b) => b / 1e6);
      expect(matchRate(det, beats, 0.035)).toBeGreaterThan(0.95);
      // no wild extra beats
      expect(det.length).toBeLessThan(beats.length * 1.08);
    });
  }

  it("finds accented downbeats", () => {
    const { samples, sampleRate, beats } = synthTrack({ bpm: 120, seconds: 30, offset: 0.25 });
    const a = analyzeAudio(samples, sampleRate);
    const det = a.beats.map((b) => b / 1e6);
    const downs = a.downbeatIndices.map((i) => det[i]);
    const truth = beats.filter((_, i) => i % 4 === 0);
    expect(a.downbeatsReliable).toBe(true);
    expect(matchRate(downs, truth, 0.035)).toBeGreaterThan(0.9);
  });

  it("segments quiet and loud halves by energy", () => {
    const { samples, sampleRate } = synthTrack({ bpm: 124, seconds: 48, loudFrom: 24 });
    const a = analyzeAudio(samples, sampleRate);
    expect(a.sections.length).toBeGreaterThanOrEqual(2);
    const boundary = a.sections[1].start / 1e6;
    expect(Math.abs(boundary - 24)).toBeLessThan(2.5);
    expect(a.sections[0].energy).toBeLessThan(a.sections[a.sections.length - 1].energy);
    expect(["drop", "high"]).toContain(a.sections[a.sections.length - 1].label);
  });

  it("uses Essentia beats when provided", () => {
    const { samples, sampleRate } = synthTrack({ bpm: 100, seconds: 12 });
    const a = analyzeAudio(samples, sampleRate, { external: { bpm: 100, beats: [0.5, 1.1, 1.7, 2.3, 2.9], confidence: 3.9 } });
    expect(a.method).toBe("essentia");
    expect(a.beats).toEqual([500000, 1100000, 1700000, 2300000, 2900000]);
  });
});
