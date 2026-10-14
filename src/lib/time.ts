import type { AspectRatio, ExportResolution, Micros } from "./types";

export const US = 1_000_000;

export const sec = (s: number): Micros => Math.round(s * US);
export const toSec = (us: Micros): number => us / US;

/**
 * Frame index of a timeline instant. All export maths goes through this single
 * function so neighbouring segments always share a boundary frame and the
 * sum of segment lengths equals the frame count of the whole timeline.
 */
export const frameAt = (us: Micros, fps: number): number =>
  Math.round((us * fps) / US);

/** Exact start time of a frame, in micros (rounded to the nearest microsecond). */
export const frameTime = (frame: number, fps: number): Micros =>
  Math.round((frame * US) / fps);

export function formatTime(us: Micros, withMs = true): string {
  const neg = us < 0;
  const t = Math.abs(us) / US;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t * 1000) % 1000);
  const base = `${neg ? "-" : ""}${m}:${String(s).padStart(2, "0")}`;
  return withMs ? `${base}.${String(ms).padStart(3, "0")}` : base;
}

export function outputSize(
  aspect: AspectRatio,
  res: ExportResolution,
): { width: number; height: number } {
  // `res` is the length of the SHORT side (720p / 1080p).
  const long = Math.round((res * 16) / 9 / 2) * 2;
  switch (aspect) {
    case "16:9":
      return { width: long, height: res };
    case "9:16":
      return { width: res, height: long };
    case "1:1":
      return { width: res, height: res };
  }
}

export const aspectValue = (a: AspectRatio): number =>
  a === "16:9" ? 16 / 9 : a === "9:16" ? 9 / 16 : 1;

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;
