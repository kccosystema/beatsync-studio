import type { TransitionType } from "../types";

export interface TransitionMeta {
  type: TransitionType;
  name: string;
  /** FFmpeg xfade transition name (null = hard cut). */
  xfade: string | null;
}

export const TRANSITIONS: TransitionMeta[] = [
  { type: "cut", name: "Hard Cut", xfade: null },
  { type: "fade", name: "Cross Dissolve", xfade: "fade" },
  { type: "fadeWhite", name: "Dip to White", xfade: "fadewhite" },
  { type: "fadeBlack", name: "Dip to Black", xfade: "fadeblack" },
  { type: "slideLeft", name: "Slide Left", xfade: "slideleft" },
  { type: "slideUp", name: "Slide Up", xfade: "slideup" },
  { type: "zoomIn", name: "Zoom Through", xfade: "zoomin" },
  { type: "wipeLeft", name: "Wipe", xfade: "wipeleft" },
  { type: "circleOpen", name: "Iris Open", xfade: "circleopen" },
];

export const transitionMeta = (t: TransitionType) => TRANSITIONS.find((m) => m.type === t)!;
