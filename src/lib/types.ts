/**
 * Core data model for BeatSync Studio.
 *
 * Every timestamp in the model is an integer number of MICROSECONDS (`Micros`).
 * Integers avoid floating-point accumulation errors; conversion to frames happens
 * only at the edges (preview drawing, export planning) via `lib/time.ts`.
 */

export type Micros = number;

export type MediaKind = "video" | "image";

export interface MediaItem {
  id: string;
  kind: MediaKind;
  name: string;
  mime: string;
  size: number;
  /** Natural duration. Images report 0 (they can be held for any length). */
  duration: Micros;
  width: number;
  height: number;
  /** Small JPEG data URL used by the media library and timeline. */
  thumbnail?: string;
  /** Visual activity 0..1 (mean frame difference of sampled frames). Images: 0. */
  motion?: number;
}

export interface AudioAsset {
  id: string;
  name: string;
  mime: string;
  size: number;
  duration: Micros;
  sampleRate: number;
}

// ---------------------------------------------------------------- analysis

export type SectionLabel =
  | "intro"
  | "low"
  | "mid"
  | "build"
  | "high"
  | "drop"
  | "breakdown"
  | "outro";

export interface Section {
  start: Micros;
  end: Micros;
  label: SectionLabel;
  /** Mean normalised energy (0..1) of the section. */
  energy: number;
}

export interface BeatAnalysis {
  /** Which beat tracker produced `beats`. */
  method: "essentia" | "builtin";
  bpm: number;
  /** Tracker confidence. Essentia: 0..5.32; builtin: 0..1 autocorrelation strength. */
  confidence: number;
  beats: Micros[];
  /** Indices into `beats` that are estimated bar starts (4/4 assumed). */
  downbeatIndices: number[];
  /** True when the bar-phase estimate was clearly better than alternatives. */
  downbeatsReliable: boolean;
  /** Normalised (0..1) energy sampled at each beat. */
  beatEnergy: number[];
  /** Energy envelope, `energyHop` apart, normalised 0..1. */
  energy: number[];
  energyHop: Micros;
  /** Strong onsets (transients). */
  transients: Micros[];
  sections: Section[];
  /** Waveform peaks (max abs per bucket), `peaksPerSecond` resolution. */
  peaks: number[];
  peaksPerSecond: number;
  duration: Micros;
  /**
   * Per-beat 12-bin chroma (pitch-class profile), L2-normalised, rounded to
   * 2 decimals. Used to find repeated sections (e.g. the chorus). Absent in
   * projects analysed before this was added.
   */
  beatChroma?: number[][];
}

// ---------------------------------------------------------------- timeline

export type EffectType =
  | "zoomIn"
  | "zoomOut"
  | "zoomPulse"
  | "shake"
  | "flash"
  | "strobe"
  | "distort"
  | "mono"
  | "rgb"
  | "hue"
  | "blackFade"
  | "split"
  | "prism"
  | "slowMo"
  | "speed"
  | "boomerang"
  | "jumpCut"
  | "fastCut";

export interface Effect {
  type: EffectType;
  /** 0..1 */
  intensity: number;
}

export type TransitionType =
  | "cut"
  | "fade"
  | "fadeWhite"
  | "fadeBlack"
  | "slideLeft"
  | "slideUp"
  | "zoomIn"
  | "wipeLeft"
  | "circleOpen";

export interface Transition {
  type: TransitionType;
  /** Total overlap length, centred on the cut point. 0 for hard cuts. */
  duration: Micros;
}

export interface TimelineClip {
  id: string;
  mediaId: string;
  /** Source in-point (where in the media this clip starts). */
  srcIn: Micros;
  /** Timeline placement; length on the timeline equals length taken from the source (1x speed). */
  start: Micros;
  end: Micros;
  effects: Effect[];
  /** Transition INTO this clip from the previous clip (ignored for the first clip). */
  transitionIn: Transition;
  /** Beat-relative pulse times (micros, clip-local) used by pulse/strobe/shake effects. */
  pulses: Micros[];
  /** Energy class of the music under this clip, for display. */
  section?: SectionLabel;
  /** Manual reframing inside the output frame (absent = centred, no extra zoom). */
  framing?: Framing;
}

/**
 * Where the source sits in the output frame. x/y run from -1 (show the
 * left/top edge of the source) through 0 (centred) to 1 (right/bottom edge);
 * scale ≥ 1 zooms in beyond "cover" so both axes can be panned.
 */
export interface Framing {
  x: number;
  y: number;
  scale: number;
}

export interface Timeline {
  clips: TimelineClip[];
  duration: Micros;
  /** Fade from black at the start / to black at the end (0 = none). */
  fadeIn: Micros;
  fadeOut: Micros;
}

// ---------------------------------------------------------------- settings

export type PresetId = "cinematic" | "edm" | "metal" | "social" | "musicvideo";
export type AspectRatio = "16:9" | "9:16" | "1:1";

export interface EditSettings {
  preset: PresetId;
  /** 0..100: higher = faster cutting. */
  intensity: number;
  /** 0..100: how many cuts receive a transition instead of a hard cut. */
  transitionFrequency: number;
  /** 0..100: strength of visual effects. */
  effectIntensity: number;
  /** Preferred clip length in beats, or 0 for "auto" (driven by preset + energy). */
  clipBeats: 0 | 1 | 2 | 4 | 8 | 16;
  /** Shifts every detected beat; positive = later. */
  syncOffset: Micros;
  /** Multiplies the detected tempo grid: 0.5 = half-time, 2 = double-time. */
  tempoScale: 0.5 | 1 | 2;
  order: "sequential" | "shuffle";
  keepClipAudio: boolean;
  /** Clip-audio level when kept (0..1). */
  clipAudioVolume: number;
  aspect: AspectRatio;
  imageBeats: number;
  seed: number;
  /** Effects switched off for this project: never auto-applied, not offered for manual use. */
  disabledEffects: EffectType[];
  /** Part of the song to use (song time). trimEnd 0 = to the end of the song. */
  trimStart: Micros;
  trimEnd: Micros;
  /** Music fade-in / fade-out at the edges of the used section. */
  audioFadeIn: Micros;
  audioFadeOut: Micros;
}

export const DEFAULT_SETTINGS: EditSettings = {
  preset: "musicvideo",
  intensity: 55,
  transitionFrequency: 40,
  effectIntensity: 60,
  clipBeats: 0,
  syncOffset: 0,
  tempoScale: 1,
  order: "sequential",
  keepClipAudio: false,
  clipAudioVolume: 0.35,
  aspect: "16:9",
  imageBeats: 4,
  seed: 1,
  disabledEffects: [],
  trimStart: 0,
  trimEnd: 0,
  audioFadeIn: 0,
  audioFadeOut: 0,
};

// ---------------------------------------------------------------- export

export type ExportResolution = 720 | 1080;
export type ExportFps = 24 | 30 | 60;

export interface ExportSettings {
  resolution: ExportResolution;
  fps: ExportFps;
}

/** Everything the render worker needs; produced by the client, consumed by the server. */
export interface RenderRequest {
  timeline: Timeline;
  media: Pick<MediaItem, "id" | "kind" | "duration" | "width" | "height" | "name">[];
  audioId: string;
  audioDuration: Micros;
  aspect: AspectRatio;
  export: ExportSettings;
  keepClipAudio: boolean;
  clipAudioVolume: number;
  /** Song time where the edit's audio starts (trimmed song). */
  audioStart?: Micros;
  audioFadeIn?: Micros;
  audioFadeOut?: Micros;
}

export interface RenderStatus {
  id: string;
  state: "queued" | "rendering" | "done" | "error" | "cancelled";
  /** 0..1, derived from frames actually encoded by FFmpeg. */
  progress: number;
  stage: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  outputBytes?: number;
}
