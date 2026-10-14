/**
 * Effects engine — the single source of truth for what every effect looks like.
 *
 * Each effect is described as a function of clip-local time τ (seconds). The
 * preview evaluates these curves in JS; the export engine turns the SAME
 * definitions into FFmpeg expressions (`*Expr` functions). Unit tests evaluate
 * both and assert they agree, so preview and export cannot drift apart.
 */
import type { Effect, EffectType, Framing, MediaItem, TimelineClip } from "../types";
import { toSec } from "../time";

export type EffectGroup = "motion" | "look" | "time";

export interface EffectMeta {
  type: EffectType;
  name: string;
  description: string;
  group: EffectGroup;
}

export const EFFECTS: EffectMeta[] = [
  { type: "zoomIn", name: "Slow Zoom In", description: "Gradual push-in across the clip", group: "motion" },
  { type: "zoomOut", name: "Slow Zoom Out", description: "Gradual pull-back across the clip", group: "motion" },
  { type: "zoomPulse", name: "Zoom Pulse", description: "Punch-in on every beat inside the clip", group: "motion" },
  { type: "shake", name: "Camera Shake", description: "Beat-driven handheld shake", group: "motion" },
  { type: "flash", name: "Flash", description: "White flash on the cut", group: "look" },
  { type: "strobe", name: "Strobe", description: "White strobe on beats and off-beats", group: "look" },
  { type: "blackFade", name: "Black Fade", description: "Clip fades up from and back down to black", group: "look" },
  { type: "rgb", name: "RGB Split", description: "Chromatic red/blue channel offset", group: "look" },
  { type: "hue", name: "Hue Cycle", description: "Colours rotate around the wheel", group: "look" },
  { type: "split", name: "Split Screen", description: "Clip repeated in 2 or 3 side-by-side panels", group: "look" },
  { type: "prism", name: "Prism", description: "Kaleidoscope mirror of the frame", group: "look" },
  { type: "distort", name: "Distortion", description: "Contrast crush, RGB split and grain", group: "look" },
  { type: "mono", name: "Mono", description: "Black & white grade", group: "look" },
  { type: "slowMo", name: "Slow-Mo", description: "Plays the footage slower (up to 4× slower)", group: "time" },
  { type: "speed", name: "Speed Up", description: "Plays the footage faster (up to 3×)", group: "time" },
  { type: "boomerang", name: "Boomerang", description: "Plays forward then rewinds", group: "time" },
  { type: "jumpCut", name: "Jump Cut", description: "Skips ahead in the footage on every beat", group: "time" },
  { type: "fastCut", name: "Fast Cut", description: "Rapid half-beat cuts between moments of the clip", group: "time" },
];

/** Effects that can't be combined (only one per clip from each set). */
export const EXCLUSIVE: EffectType[][] = [
  ["zoomIn", "zoomOut"],
  ["slowMo", "speed", "boomerang", "jumpCut", "fastCut"],
  ["split", "prism"],
];

// Tunables shared by preview + export.
export const K = {
  zoomRamp: 0.18,
  pulseAmp: 0.12,
  pulseDecay: 0.12,
  shakeAmp: 0.022,
  shakeMargin: 0.06,
  shakeDecay: 0.15,
  shakeFx: 11,
  shakeFy: 7,
  flashDecay: 0.18,
  strobeDecay: 0.05,
  strobeAmp: 0.85,
  rgbShift: 0.012,
  hueSpeed: 180,
  blackFadeMin: 0.12,
  blackFadeMax: 0.6,
};

export interface ClipFx {
  /** seconds */
  dur: number;
  pulses: number[];
  strobeTimes: number[];
  zoomIn: number;
  zoomOut: number;
  zoomPulse: number;
  shake: number;
  flash: number;
  strobe: number;
  distort: number;
  mono: number;
  rgb: number;
  hue: number;
  blackFade: number;
  split: number;
  prism: number;
}

export function clipFx(clip: Pick<TimelineClip, "start" | "end" | "effects" | "pulses">): ClipFx {
  const get = (t: EffectType) => clip.effects.find((e: Effect) => e.type === t)?.intensity ?? 0;
  const pulses = clip.pulses.map(toSec);
  const strobeTimes: number[] = [];
  pulses.forEach((p, i) => {
    strobeTimes.push(p);
    const next = pulses[i + 1] ?? toSec(clip.end - clip.start);
    if (next - p > 0.12) strobeTimes.push(p + (next - p) / 2);
  });
  return {
    dur: toSec(clip.end - clip.start),
    pulses,
    strobeTimes,
    zoomIn: get("zoomIn"),
    zoomOut: get("zoomOut"),
    zoomPulse: get("zoomPulse"),
    shake: get("shake"),
    flash: get("flash"),
    strobe: get("strobe"),
    distort: get("distort"),
    mono: get("mono"),
    rgb: get("rgb"),
    hue: get("hue"),
    blackFade: get("blackFade"),
    split: get("split"),
    prism: get("prism"),
  };
}

export const hasMotion = (f: ClipFx) => f.zoomIn > 0 || f.zoomOut > 0 || f.zoomPulse > 0 || f.shake > 0;
export const hasFlash = (f: ClipFx) => f.flash > 0 || f.strobe > 0;

// ------------------------------------------------------------- framing

export const FRAMING_MAX_SCALE = 3;

export function framingOf(clip: Pick<TimelineClip, "framing">): Framing {
  const f = clip.framing;
  const c = (v: number | undefined) => Math.max(-1, Math.min(1, Number.isFinite(v) ? (v as number) : 0));
  return { x: c(f?.x), y: c(f?.y), scale: Math.max(1, Math.min(FRAMING_MAX_SCALE, f?.scale ?? 1)) };
}

/**
 * Visible source rectangle (in source pixels) for a framed clip before effects.
 * The preview draws exactly this rectangle; the export reproduces it with
 * scale(cover × scale) + crop at ((iw-ow)/2·(1+x), (ih-oh)/2·(1+y)).
 */
export function framedRect(srcW: number, srcH: number, outW: number, outH: number, framing: Framing) {
  const k = Math.max(outW / srcW, outH / srcH) * framing.scale; // source px → output px
  const w = outW / k, h = outH / k;
  return { x: ((srcW - w) / 2) * (1 + framing.x), y: ((srcH - h) / 2) * (1 + framing.y), w, h, k };
}

// ------------------------------------------------------------- JS curves

const decay = (x: number, k: number) => (x >= 0 ? Math.exp(-x / k) : 0);

export function zoomAt(f: ClipFx, tau: number): number {
  let z = 1;
  const p = clamp01(tau / Math.max(1e-6, f.dur));
  if (f.zoomIn) z += K.zoomRamp * f.zoomIn * p;
  if (f.zoomOut) z += K.zoomRamp * f.zoomOut * (1 - p);
  if (f.zoomPulse) {
    let s = 0;
    for (const q of f.pulses) s += decay(tau - q, K.pulseDecay);
    z += K.pulseAmp * f.zoomPulse * s;
  }
  if (f.shake) z += K.shakeMargin * f.shake;
  return z;
}

/** Shake offset as a fraction of output width / height. */
export function shakeAt(f: ClipFx, tau: number): { dx: number; dy: number } {
  if (!f.shake) return { dx: 0, dy: 0 };
  let s = 0;
  for (const q of f.pulses) s += decay(tau - q, K.shakeDecay);
  const env = 0.3 + 0.7 * Math.min(1, s);
  const a = K.shakeAmp * f.shake * env;
  return {
    dx: a * Math.sin(2 * Math.PI * K.shakeFx * tau + 0.7),
    dy: a * Math.cos(2 * Math.PI * K.shakeFy * tau + 1.3),
  };
}

/** White overlay opacity 0..1. */
export function flashAt(f: ClipFx, tau: number): number {
  let a = 0;
  if (f.flash) a += f.flash * decay(tau, K.flashDecay);
  if (f.strobe) {
    let s = 0;
    for (const q of f.strobeTimes) s += decay(tau - q, K.strobeDecay);
    a += K.strobeAmp * f.strobe * s;
  }
  return Math.min(1, a);
}

export function distortParams(f: ClipFx, outWidth: number) {
  return {
    contrast: 1 + 0.35 * f.distort,
    saturation: (1 + 0.5 * f.distort) * (1 - f.mono),
    rgbShift: Math.round(Math.max(0.006 * f.distort, K.rgbShift * f.rgb) * outWidth),
    noise: Math.round(18 * f.distort),
  };
}

/** Hue rotation in degrees at clip-local time τ. */
export const hueAt = (f: ClipFx, tau: number) => K.hueSpeed * f.hue * tau;

/** Panels for split screen: 2 below 50% intensity, 3 above. */
export const splitPanels = (f: ClipFx) => (f.split > 0 ? (f.split < 0.5 ? 2 : 3) : 1);

const blackFadeLen = (f: ClipFx) => Math.min(f.dur / 2, K.blackFadeMin + (K.blackFadeMax - K.blackFadeMin) * f.blackFade);

/** Black overlay opacity from the per-clip Black Fade effect. */
export function blackFadeAt(f: ClipFx, tau: number): number {
  if (!f.blackFade) return 0;
  const L = blackFadeLen(f);
  return Math.max(0, Math.min(1, Math.max(1 - tau / L, 1 - (f.dur - tau) / L)));
}

// ------------------------------------------------------- FFmpeg expressions
// Expressions are built from the same constants; `T` is an FFmpeg expression
// for clip-local time in seconds (e.g. "(on/30+-0.25)" or "(t+1.5)").

const n = (v: number) => {
  const s = (Math.round(v * 1e6) / 1e6).toString();
  return v < 0 ? `(${s})` : s;
};
const decayExpr = (T: string, at: number, k: number) =>
  `gte(${T},${n(at)})*exp(-(${T}-${n(at)})/${n(k)})`;

export function zoomExpr(f: ClipFx, T: string): string {
  const parts = ["1"];
  const p = `min(max(${T}/${n(Math.max(1e-6, f.dur))},0),1)`;
  if (f.zoomIn) parts.push(`${n(K.zoomRamp * f.zoomIn)}*${p}`);
  if (f.zoomOut) parts.push(`${n(K.zoomRamp * f.zoomOut)}*(1-${p})`);
  if (f.zoomPulse && f.pulses.length)
    parts.push(`${n(K.pulseAmp * f.zoomPulse)}*(${f.pulses.map((q) => decayExpr(T, q, K.pulseDecay)).join("+")})`);
  if (f.shake) parts.push(n(K.shakeMargin * f.shake));
  return parts.join("+");
}

export function shakeExpr(f: ClipFx, T: string): { dx: string; dy: string } {
  if (!f.shake) return { dx: "0", dy: "0" };
  const sum = f.pulses.length ? f.pulses.map((q) => decayExpr(T, q, K.shakeDecay)).join("+") : "0";
  const a = `${n(K.shakeAmp * f.shake)}*(0.3+0.7*min(1,${sum}))`;
  return {
    dx: `${a}*sin(2*PI*${K.shakeFx}*${T}+0.7)`,
    dy: `${a}*cos(2*PI*${K.shakeFy}*${T}+1.3)`,
  };
}

export function flashExpr(f: ClipFx, T: string): string {
  const parts: string[] = [];
  if (f.flash) parts.push(`${n(f.flash)}*${decayExpr(T, 0, K.flashDecay)}`);
  if (f.strobe && f.strobeTimes.length)
    parts.push(`${n(K.strobeAmp * f.strobe)}*(${f.strobeTimes.map((q) => decayExpr(T, q, K.strobeDecay)).join("+")})`);
  return parts.length ? `min(1,${parts.join("+")})` : "0";
}

export function hueExpr(f: ClipFx, T: string): string {
  return `${n(K.hueSpeed * f.hue)}*${T}`;
}

export function blackFadeExpr(f: ClipFx, T: string): string {
  if (!f.blackFade) return "0";
  const L = n(blackFadeLen(f));
  return `max(0,min(1,max(1-${T}/${L},1-(${n(f.dur)}-${T})/${L})))`;
}

// ------------------------------------------------------------- time remapping
// Slow-mo, speed, boomerang, jump cut and fast cut change WHICH source frame
// plays at each clip-local time. A clip's time map is a list of linear
// segments; source time at τ in segment s is s.src + (τ - s.t0) * s.rate.
// The first/last segments extend to ±∞ so transition handles stay defined.

export interface TimeSeg {
  t0: number;
  t1: number;
  src: number;
  rate: number;
}

export const TIME_EFFECTS: EffectType[] = ["slowMo", "speed", "boomerang", "jumpCut", "fastCut"];

/** Deterministic 0..1 hash so fast-cut positions are stable per clip. */
function hash01(str: string, i: number): number {
  let h = 2166136261 ^ i;
  for (let k = 0; k < str.length; k++) h = Math.imul(h ^ str.charCodeAt(k), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export function timeMap(
  clip: Pick<TimelineClip, "id" | "start" | "end" | "srcIn" | "effects" | "pulses">,
  media?: Pick<MediaItem, "kind" | "duration">,
): TimeSeg[] {
  const dur = toSec(clip.end - clip.start);
  const src0 = toSec(clip.srcIn);
  const fx = clip.effects.find((e) => TIME_EFFECTS.includes(e.type));
  const linear = (rate: number): TimeSeg[] => [{ t0: -Infinity, t1: Infinity, src: src0, rate }];
  if (!fx || media?.kind === "image") return linear(1);
  const a = fx.intensity;
  const pulses = clip.pulses.map(toSec).filter((p) => p > 0.05 && p < dur - 0.05);
  const beat = pulses.length >= 1 ? (pulses.length >= 2 ? pulses[1] - pulses[0] : pulses[0]) : Math.min(0.5, dur / 2);
  switch (fx.type) {
    case "slowMo":
      return linear(Math.max(0.25, 1 - 0.75 * a));
    case "speed":
      return linear(1 + 2 * a);
    case "boomerang": {
      const half = dur / 2;
      return [
        { t0: -Infinity, t1: half, src: src0, rate: 1 },
        { t0: half, t1: Infinity, src: src0 + half, rate: -1 },
      ];
    }
    case "jumpCut": {
      const skip = beat * (0.5 + a);
      const cuts = [-Infinity, ...pulses, Infinity];
      return cuts.slice(0, -1).map((t0, i) => ({
        t0,
        t1: cuts[i + 1],
        src: src0 + (i === 0 ? 0 : pulses[i - 1] + i * skip),
        rate: 1,
      }));
    }
    case "fastCut": {
      const D = media ? toSec(media.duration) : dur;
      const step = Math.max(0.12, beat / (a >= 0.5 ? 2 : 1));
      const cuts = [-Infinity];
      for (let t = step; t < dur - step / 2; t += step) cuts.push(t);
      cuts.push(Infinity);
      return cuts.slice(0, -1).map((t0, i) => {
        const len = Math.min(step, D);
        const pos = i === 0 ? src0 : hash01(clip.id, i) * Math.max(0, D - len);
        return { t0, t1: cuts[i + 1], src: pos, rate: 1 };
      });
    }
    default:
      return linear(1);
  }
}

export function segAt(map: TimeSeg[], tau: number): TimeSeg {
  for (const s of map) if (tau >= s.t0 && tau < s.t1) return s;
  return map[map.length - 1];
}

/** Source time (s) shown at clip-local time τ, clamped to the media. */
export function sourceTimeAt(map: TimeSeg[], tau: number, mediaDur?: number): number {
  const s = segAt(map, tau);
  const base = s.t0 === -Infinity ? 0 : s.t0;
  const v = s.src + (s.t0 === -Infinity ? tau : tau - base) * s.rate;
  return mediaDur !== undefined ? Math.max(0, Math.min(v, mediaDur)) : Math.max(0, v);
}

/** Source seconds a clip consumes beyond its in-point (for picking in-points with enough footage). */
export function sourceSpan(map: TimeSeg[], dur: number): number {
  let max = 0;
  for (const s of map) {
    const a = Math.max(0, s.t0), b = Math.min(dur, s.t1);
    if (b <= a) continue;
    max = Math.max(max, sourceTimeAt(map, a), sourceTimeAt(map, b));
  }
  return max - (map[0]?.src ?? 0);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
