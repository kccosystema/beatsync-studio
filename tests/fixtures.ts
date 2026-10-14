import type { BeatAnalysis, MediaItem, EditSettings } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";

/** A clean 120 BPM analysis: 60 s, quiet first half, drop at 30 s. */
export function fakeAnalysis(opts: { bpm?: number; seconds?: number; dropAt?: number } = {}): BeatAnalysis {
  const bpm = opts.bpm ?? 120, seconds = opts.seconds ?? 60, dropAt = opts.dropAt ?? 30;
  const period = Math.round(60e6 / bpm);
  const beats: number[] = [];
  for (let t = 250_000; t < seconds * 1e6; t += period) beats.push(t);
  const beatEnergy = beats.map((b) => (b < dropAt * 1e6 ? 0.3 : 0.9));
  const dropIdx = beats.findIndex((b) => b >= dropAt * 1e6);
  return {
    method: "builtin", bpm, confidence: 0.9, beats,
    downbeatIndices: beats.map((_, i) => i).filter((i) => i % 4 === 0),
    downbeatsReliable: true, beatEnergy, energy: [], energyHop: 50_000, transients: [],
    sections: dropIdx < 0
      ? [{ start: 0, end: seconds * 1e6, label: "low", energy: 0.3 }]
      : [
          { start: 0, end: beats[dropIdx], label: "intro", energy: 0.3 },
          { start: beats[dropIdx], end: seconds * 1e6, label: "drop", energy: 0.9 },
        ],
    peaks: [], peaksPerSecond: 100, duration: seconds * 1e6,
  };
}

export function fakeMedia(n = 6, seconds = 20): MediaItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, kind: i === n - 1 ? "image" : "video", name: `clip${i}.mp4`, mime: "video/mp4", size: 1,
    duration: i === n - 1 ? 0 : seconds * 1e6, width: 1920, height: 1080, motion: (i % 3) / 2,
  }));
}

export const settings = (p: Partial<EditSettings> = {}): EditSettings => ({ ...DEFAULT_SETTINGS, ...p });
