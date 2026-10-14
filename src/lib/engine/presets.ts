/**
 * Editing presets. Each preset is a full set of rules that the generator
 * consumes — cut lengths per energy level, transition pools and odds, effect
 * odds, bar alignment and intro/outro fades — so switching preset changes the
 * actual edit, not just a label.
 */
import type { EffectType, PresetId, TransitionType } from "../types";

/** Energy classes the generator reasons about. `peak` = the opening bars of a drop. */
export type EnergyClass = "low" | "mid" | "high" | "peak";
export const ENERGY_CLASSES: EnergyClass[] = ["low", "mid", "high", "peak"];

export interface LengthRule {
  /** Candidate clip lengths in beats. */
  beats: number[];
  weights: number[];
}

export interface TransitionRule {
  /** Probability (at transition frequency 50) that a cut gets a transition. */
  prob: number;
  types: TransitionType[];
  weights: number[];
  /** Transition length in beats. */
  beats: number;
}

export interface EffectRule {
  type: EffectType;
  /** Probability (at effect intensity 50) that a clip gets this effect. */
  prob: number;
  intensity: number;
}

export interface Preset {
  id: PresetId;
  name: string;
  tagline: string;
  lengths: Record<EnergyClass, LengthRule>;
  transitions: Record<EnergyClass, TransitionRule>;
  effects: Record<EnergyClass, EffectRule[]>;
  /** Snap cuts of ≥4 beats to bar lines. */
  barAlign: boolean;
  /** Bars at the start of a drop that are treated as `peak`. */
  peakBars: number;
  /** Accelerate cutting through build-ups. */
  accelerateBuilds: boolean;
  /** Beats of fade-from-black / fade-to-black. */
  fadeInBeats: number;
  fadeOutBeats: number;
  /** Hit drops with flash + shake + pulse. */
  dropImpact: boolean;
}

const L = (beats: number[], weights: number[]): LengthRule => ({ beats, weights });
const T = (prob: number, types: TransitionType[], weights: number[], beats: number): TransitionRule => ({ prob, types, weights, beats });

export const PRESETS: Record<PresetId, Preset> = {
  cinematic: {
    id: "cinematic",
    name: "Cinematic",
    tagline: "Long takes, smooth dissolves, gentle push-ins",
    lengths: {
      low: L([8, 16], [1, 1]),
      mid: L([4, 8, 16], [1, 3, 1]),
      high: L([4, 8], [2, 2]),
      peak: L([2, 4], [1, 2]),
    },
    transitions: {
      low: T(0.85, ["fade", "fadeBlack"], [4, 1], 2),
      mid: T(0.7, ["fade", "fadeBlack", "fadeWhite"], [5, 1, 1], 1.5),
      high: T(0.45, ["fade", "fadeWhite"], [3, 1], 1),
      peak: T(0.2, ["fadeWhite"], [1], 0.5),
    },
    effects: {
      low: [{ type: "zoomIn", prob: 0.6, intensity: 0.5 }, { type: "zoomOut", prob: 0.3, intensity: 0.5 }, { type: "slowMo", prob: 0.25, intensity: 0.5 }, { type: "blackFade", prob: 0.1, intensity: 0.5 }],
      mid: [{ type: "zoomIn", prob: 0.5, intensity: 0.6 }, { type: "zoomOut", prob: 0.3, intensity: 0.6 }, { type: "slowMo", prob: 0.15, intensity: 0.45 }],
      high: [{ type: "zoomIn", prob: 0.5, intensity: 0.8 }, { type: "zoomPulse", prob: 0.15, intensity: 0.35 }],
      peak: [{ type: "zoomPulse", prob: 0.4, intensity: 0.45 }, { type: "flash", prob: 0.25, intensity: 0.4 }, { type: "shake", prob: 0.05, intensity: 0.2 }, { type: "prism", prob: 0.05, intensity: 0.5 }],
    },
    barAlign: true,
    peakBars: 4,
    accelerateBuilds: false,
    fadeInBeats: 4,
    fadeOutBeats: 8,
    dropImpact: false,
  },
  edm: {
    id: "edm",
    name: "EDM / Rave",
    tagline: "Rapid beat cuts, white flashes, strobes and zoom pulses",
    lengths: {
      low: L([4, 8], [2, 1]),
      mid: L([2, 4], [1, 2]),
      high: L([1, 2, 4], [1, 3, 1]),
      peak: L([1, 2], [3, 2]),
    },
    transitions: {
      low: T(0.5, ["fade", "zoomIn", "fadeWhite"], [2, 1, 1], 1),
      mid: T(0.35, ["zoomIn", "fadeWhite", "slideLeft"], [2, 2, 1], 0.5),
      high: T(0.12, ["fadeWhite", "zoomIn"], [2, 1], 0.25),
      peak: T(0.05, ["fadeWhite"], [1], 0.25),
    },
    effects: {
      low: [{ type: "zoomIn", prob: 0.5, intensity: 0.6 }],
      mid: [{ type: "zoomPulse", prob: 0.55, intensity: 0.6 }, { type: "flash", prob: 0.3, intensity: 0.5 }, { type: "hue", prob: 0.15, intensity: 0.5 }, { type: "rgb", prob: 0.15, intensity: 0.5 }],
      high: [{ type: "zoomPulse", prob: 0.7, intensity: 0.8 }, { type: "flash", prob: 0.55, intensity: 0.75 }, { type: "strobe", prob: 0.15, intensity: 0.5 }, { type: "rgb", prob: 0.25, intensity: 0.6 }, { type: "fastCut", prob: 0.1, intensity: 0.6 }, { type: "split", prob: 0.08, intensity: 0.7 }],
      peak: [{ type: "zoomPulse", prob: 0.85, intensity: 1 }, { type: "flash", prob: 0.75, intensity: 0.9 }, { type: "strobe", prob: 0.35, intensity: 0.65 }, { type: "shake", prob: 0.25, intensity: 0.5 }, { type: "rgb", prob: 0.35, intensity: 0.8 }, { type: "hue", prob: 0.2, intensity: 0.7 }, { type: "prism", prob: 0.15, intensity: 0.8 }, { type: "fastCut", prob: 0.15, intensity: 0.7 }],
    },
    barAlign: true,
    peakBars: 8,
    accelerateBuilds: true,
    fadeInBeats: 0,
    fadeOutBeats: 4,
    dropImpact: true,
  },
  metal: {
    id: "metal",
    name: "Metal / Rock",
    tagline: "Aggressive hard cuts, shake, impact zooms and distortion",
    lengths: {
      low: L([4, 8], [2, 1]),
      mid: L([2, 4], [2, 2]),
      high: L([1, 2, 4], [1, 3, 1]),
      peak: L([1, 2], [2, 2]),
    },
    transitions: {
      low: T(0.35, ["fadeBlack", "fade"], [2, 1], 1),
      mid: T(0.12, ["fadeBlack", "wipeLeft"], [1, 1], 0.5),
      high: T(0.04, ["fadeWhite"], [1], 0.25),
      peak: T(0, ["fadeWhite"], [1], 0.25),
    },
    effects: {
      low: [{ type: "zoomIn", prob: 0.4, intensity: 0.6 }, { type: "mono", prob: 0.25, intensity: 1 }],
      mid: [{ type: "shake", prob: 0.45, intensity: 0.5 }, { type: "zoomPulse", prob: 0.35, intensity: 0.6 }, { type: "distort", prob: 0.25, intensity: 0.5 }, { type: "jumpCut", prob: 0.15, intensity: 0.5 }],
      high: [{ type: "shake", prob: 0.75, intensity: 0.8 }, { type: "zoomPulse", prob: 0.5, intensity: 0.8 }, { type: "distort", prob: 0.5, intensity: 0.7 }, { type: "flash", prob: 0.25, intensity: 0.6 }, { type: "rgb", prob: 0.3, intensity: 0.7 }, { type: "jumpCut", prob: 0.2, intensity: 0.6 }, { type: "speed", prob: 0.1, intensity: 0.5 }],
      peak: [{ type: "shake", prob: 0.9, intensity: 1 }, { type: "zoomPulse", prob: 0.7, intensity: 1 }, { type: "distort", prob: 0.7, intensity: 0.9 }, { type: "flash", prob: 0.45, intensity: 0.8 }, { type: "rgb", prob: 0.45, intensity: 0.9 }, { type: "jumpCut", prob: 0.25, intensity: 0.7 }],
    },
    barAlign: true,
    peakBars: 4,
    accelerateBuilds: true,
    fadeInBeats: 0,
    fadeOutBeats: 2,
    dropImpact: true,
  },
  social: {
    id: "social",
    name: "Social Media",
    tagline: "Quick punchy cuts for TikTok, Reels and Shorts",
    lengths: {
      low: L([2, 4], [2, 1]),
      mid: L([2, 4], [3, 1]),
      high: L([1, 2], [1, 2]),
      peak: L([1, 2], [2, 1]),
    },
    transitions: {
      low: T(0.45, ["slideLeft", "slideUp", "zoomIn"], [1, 1, 1], 0.5),
      mid: T(0.35, ["slideUp", "zoomIn", "slideLeft"], [1, 2, 1], 0.5),
      high: T(0.15, ["zoomIn", "fadeWhite"], [2, 1], 0.25),
      peak: T(0.08, ["zoomIn"], [1], 0.25),
    },
    effects: {
      low: [{ type: "zoomIn", prob: 0.6, intensity: 0.8 }, { type: "speed", prob: 0.2, intensity: 0.5 }],
      mid: [{ type: "zoomPulse", prob: 0.5, intensity: 0.7 }, { type: "zoomIn", prob: 0.3, intensity: 0.8 }, { type: "jumpCut", prob: 0.2, intensity: 0.5 }, { type: "split", prob: 0.1, intensity: 0.4 }],
      high: [{ type: "zoomPulse", prob: 0.65, intensity: 0.85 }, { type: "flash", prob: 0.35, intensity: 0.6 }, { type: "shake", prob: 0.2, intensity: 0.4 }, { type: "speed", prob: 0.15, intensity: 0.6 }, { type: "boomerang", prob: 0.1, intensity: 1 }, { type: "split", prob: 0.12, intensity: 0.7 }],
      peak: [{ type: "zoomPulse", prob: 0.8, intensity: 1 }, { type: "flash", prob: 0.5, intensity: 0.8 }, { type: "shake", prob: 0.35, intensity: 0.5 }, { type: "fastCut", prob: 0.15, intensity: 0.7 }, { type: "rgb", prob: 0.2, intensity: 0.6 }],
    },
    barAlign: false,
    peakBars: 4,
    accelerateBuilds: true,
    fadeInBeats: 0,
    fadeOutBeats: 1,
    dropImpact: true,
  },
  musicvideo: {
    id: "musicvideo",
    name: "Music Video",
    tagline: "Dynamic pacing that follows the song's energy, cinematic bookends",
    lengths: {
      low: L([4, 8, 16], [2, 3, 1]),
      mid: L([2, 4, 8], [1, 3, 1]),
      high: L([1, 2, 4], [1, 3, 2]),
      peak: L([1, 2], [1, 2]),
    },
    transitions: {
      low: T(0.6, ["fade", "fadeBlack", "circleOpen"], [4, 1, 1], 1.5),
      mid: T(0.4, ["fade", "wipeLeft", "slideLeft", "zoomIn"], [3, 1, 1, 1], 1),
      high: T(0.18, ["fadeWhite", "zoomIn", "fade"], [2, 2, 1], 0.5),
      peak: T(0.05, ["fadeWhite"], [1], 0.25),
    },
    effects: {
      low: [{ type: "zoomIn", prob: 0.5, intensity: 0.6 }, { type: "zoomOut", prob: 0.25, intensity: 0.6 }, { type: "slowMo", prob: 0.2, intensity: 0.5 }, { type: "blackFade", prob: 0.08, intensity: 0.5 }],
      mid: [{ type: "zoomIn", prob: 0.35, intensity: 0.7 }, { type: "zoomPulse", prob: 0.3, intensity: 0.6 }, { type: "boomerang", prob: 0.06, intensity: 1 }, { type: "hue", prob: 0.06, intensity: 0.4 }],
      high: [{ type: "zoomPulse", prob: 0.55, intensity: 0.8 }, { type: "flash", prob: 0.35, intensity: 0.6 }, { type: "shake", prob: 0.2, intensity: 0.45 }, { type: "rgb", prob: 0.15, intensity: 0.6 }, { type: "jumpCut", prob: 0.1, intensity: 0.5 }, { type: "split", prob: 0.06, intensity: 0.4 }],
      peak: [{ type: "zoomPulse", prob: 0.75, intensity: 0.95 }, { type: "flash", prob: 0.6, intensity: 0.85 }, { type: "shake", prob: 0.4, intensity: 0.6 }, { type: "strobe", prob: 0.12, intensity: 0.5 }, { type: "rgb", prob: 0.25, intensity: 0.7 }, { type: "prism", prob: 0.1, intensity: 0.7 }, { type: "fastCut", prob: 0.1, intensity: 0.6 }],
    },
    barAlign: true,
    peakBars: 8,
    accelerateBuilds: true,
    fadeInBeats: 2,
    fadeOutBeats: 4,
    dropImpact: true,
  },
};

export const PRESET_LIST = Object.values(PRESETS);
