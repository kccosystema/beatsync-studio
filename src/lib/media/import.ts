/**
 * Media manager: validation, metadata probing, thumbnails and a cheap visual
 * "motion" score (mean frame difference) used by the editing engine.
 */
import { nanoid } from "nanoid";
import type { AudioAsset, MediaItem } from "../types";
import { sec } from "../time";

export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"];
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const AUDIO_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/x-aac"];
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac)$/i;

export const MAX_MEDIA = 60;

export type FileKind = "video" | "image" | "audio" | null;

export function classify(file: File): FileKind {
  if (VIDEO_TYPES.includes(file.type) || (!file.type && VIDEO_EXT.test(file.name)) || VIDEO_EXT.test(file.name)) return "video";
  if (IMAGE_TYPES.includes(file.type) || IMAGE_EXT.test(file.name)) return "image";
  if (AUDIO_TYPES.includes(file.type) || AUDIO_EXT.test(file.name)) return "audio";
  return null;
}

export const newId = () => nanoid(16);

const THUMB_W = 192;

function waitFor(el: HTMLMediaElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => cleanup(new Error(`Timed out waiting for ${event}`)), ms);
    const ok = () => cleanup();
    const bad = () => cleanup(new Error("The browser could not decode this file"));
    function cleanup(err?: Error) {
      clearTimeout(t);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", bad);
      if (err) reject(err); else resolve();
    }
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });
}

async function seek(v: HTMLVideoElement, t: number) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return;
  const p = waitFor(v, "seeked", 8000);
  v.currentTime = t;
  await p;
}

export async function importVisual(file: File, kind: "video" | "image"): Promise<{ item: MediaItem; url: string }> {
  const url = URL.createObjectURL(file);
  try {
    if (kind === "image") {
      const bmp = await createImageBitmap(file).catch(() => {
        throw new Error("Unsupported or corrupt image");
      });
      const thumb = drawThumb(bmp, bmp.width, bmp.height);
      const item: MediaItem = { id: newId(), kind, name: file.name, mime: file.type || "image/*", size: file.size, duration: 0, width: bmp.width, height: bmp.height, thumbnail: thumb, motion: 0 };
      bmp.close();
      return { item, url };
    }
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    await waitFor(v, "loadedmetadata", 15000);
    if (!isFinite(v.duration) || v.duration <= 0 || !v.videoWidth) throw new Error("Video has no playable video track in this browser");
    const dur = v.duration;
    // motion: sample 6 frames at 32×18 luma and average absolute differences
    const small = document.createElement("canvas");
    small.width = 32; small.height = 18;
    const sctx = small.getContext("2d", { willReadFrequently: true })!;
    const samples: Uint8ClampedArray[] = [];
    let thumb = "";
    const points = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((p) => Math.min(dur - 0.05, p * dur));
    for (let i = 0; i < points.length; i++) {
      await seek(v, Math.max(0, points[i]));
      if (i === 0) thumb = drawThumb(v, v.videoWidth, v.videoHeight);
      sctx.drawImage(v, 0, 0, 32, 18);
      samples.push(sctx.getImageData(0, 0, 32, 18).data.slice());
      // also a near-neighbour frame to measure motion rather than scene changes
      await seek(v, Math.min(dur - 0.01, points[i] + 0.2));
      sctx.drawImage(v, 0, 0, 32, 18);
      samples.push(sctx.getImageData(0, 0, 32, 18).data.slice());
    }
    let diff = 0, cnt = 0;
    for (let i = 0; i < samples.length; i += 2) {
      const a = samples[i], b = samples[i + 1];
      for (let p = 0; p < a.length; p += 4) {
        diff += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
        cnt += 3;
      }
    }
    const motion = Math.min(1, diff / Math.max(1, cnt) / 25);
    const item: MediaItem = {
      id: newId(), kind, name: file.name, mime: file.type || "video/*", size: file.size,
      duration: sec(dur), width: v.videoWidth, height: v.videoHeight, thumbnail: thumb, motion: Math.round(motion * 100) / 100,
    };
    v.removeAttribute("src");
    v.load();
    return { item, url };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function drawThumb(src: CanvasImageSource, w: number, h: number): string {
  const c = document.createElement("canvas");
  c.width = THUMB_W;
  c.height = Math.round((THUMB_W * 9) / 16);
  const ctx = c.getContext("2d")!;
  const scale = Math.max(c.width / w, c.height / h);
  const dw = w * scale, dh = h * scale;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
  return c.toDataURL("image/jpeg", 0.72);
}

export async function probeAudio(file: File): Promise<{ asset: AudioAsset; url: string }> {
  const url = URL.createObjectURL(file);
  const a = document.createElement("audio");
  a.preload = "metadata";
  a.src = url;
  try {
    await waitFor(a, "loadedmetadata", 15000);
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return {
    asset: { id: newId(), name: file.name, mime: file.type || "audio/*", size: file.size, duration: sec(a.duration), sampleRate: 0 },
    url,
  };
}

/** Run async tasks with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = { status: "fulfilled", value: await fn(items[k], k) };
        } catch (reason) {
          out[k] = { status: "rejected", reason };
        }
      }
    }),
  );
  return out;
}
