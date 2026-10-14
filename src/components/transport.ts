"use client";
/** Thin bridge between UI controls and the mounted PreviewEngine. */
import type { PreviewEngine } from "@/lib/preview/compositor";
import { useStudio } from "@/store/studio";
import type { Framing, Micros } from "@/lib/types";

let engine: PreviewEngine | null = null;

export const transport = {
  attach(e: PreviewEngine | null) {
    engine = e;
  },
  async play() {
    if (!engine) return;
    try {
      await engine.play();
      useStudio.getState().setPlaying(true);
    } catch {
      useStudio.getState().toast("Playback was blocked by the browser — click play again", "error");
    }
  },
  pause() {
    if (!engine) return;
    engine.pause();
    const s = useStudio.getState();
    s.setPlaying(false);
    s.setPlayhead(engine.time);
  },
  toggle() {
    if (engine?.isPlaying()) transport.pause();
    else void transport.play();
  },
  seek(t: Micros) {
    const s = useStudio.getState();
    const max = s.timeline?.duration ?? (s.audio ? (s.settings.trimEnd || s.audio.duration) - s.settings.trimStart : 0);
    const clamped = Math.max(0, Math.min(t, max));
    engine?.seek(clamped);
    s.setPlayhead(clamped);
  },
  setFramingOverride(o: { clipId: string; framing: Framing } | null) {
    engine?.setFramingOverride(o);
  },
  time(): Micros {
    return engine?.time ?? useStudio.getState().playhead;
  },
};
