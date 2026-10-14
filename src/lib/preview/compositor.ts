/**
 * Preview renderer.
 *
 * - The song's <audio> element is the master clock; video elements follow it
 *   and are re-seeked when they drift.
 * - A small pool of <video> elements is assigned to the current, neighbouring
 *   and upcoming clips; upcoming clips are pre-seeked so cuts are instant.
 * - Each frame is composited on a 2D canvas using the SAME effect curves the
 *   export engine compiles into FFmpeg expressions (lib/engine/effects).
 */
import type { Framing, MediaItem, Micros, Timeline, TimelineClip, TransitionType } from "../types";
import { aspectValue } from "../time";
import {
  blackFadeAt, clipFx, framedRect, framingOf, distortParams, flashAt, hueAt, segAt, shakeAt, sourceTimeAt, splitPanels, timeMap, zoomAt, type ClipFx,
} from "../engine/effects";
import type { AspectRatio } from "../types";
import { fadeAlpha, splitPanelWidth } from "../export/plan";

export interface PreviewSources {
  url: (mediaId: string) => string | undefined;
  media: (mediaId: string) => MediaItem | undefined;
}

interface Slot {
  el: HTMLVideoElement;
  clipId: string | null;
  mediaId: string | null;
  lastUsed: number;
}

const POOL_SIZE = 6;
const DRIFT_PLAYING = 0.12;

export class PreviewEngine {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private audio: HTMLAudioElement;
  private slots: Slot[] = [];
  private images = new Map<string, HTMLImageElement>();
  private timeline: Timeline | null = null;
  private sources: PreviewSources;
  private raf = 0;
  private pausedTime: Micros = 0;
  private playing = false;
  private needsDraw = true;
  private off: HTMLCanvasElement[] = [];
  private noise: HTMLCanvasElement;
  private onTime: (t: Micros) => void;
  private onEnded: () => void;
  private keepClipAudio = false;
  private clipAudioVolume = 0.35;
  private aspect: AspectRatio = "16:9";
  private destroyed = false;
  /** Live framing while the user drags in adjust mode (committed to the timeline on release). */
  private framingOverride: { clipId: string; framing: Framing } | null = null;
  private win = { start: 0, length: 0, fadeIn: 0, fadeOut: 0 };
  /** Frames drawn, for diagnostics. */
  frames = 0;

  constructor(canvas: HTMLCanvasElement, sources: PreviewSources, onTime: (t: Micros) => void, onEnded: () => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.sources = sources;
    this.onTime = onTime;
    this.onEnded = onEnded;
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => {
      this.playing = false;
      this.pausedTime = this.timeline?.duration ?? 0;
      this.pauseVideos();
      this.onEnded();
    });
    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      el.addEventListener("seeked", () => (this.needsDraw = true));
      el.addEventListener("loadeddata", () => (this.needsDraw = true));
      this.slots.push({ el, clipId: null, mediaId: null, lastUsed: 0 });
    }
    this.noise = makeNoise();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.audio.removeAttribute("src");
    for (const s of this.slots) {
      s.el.pause();
      s.el.removeAttribute("src");
      s.el.load();
    }
  }

  setAudio(url: string | undefined) {
    if (!url) {
      this.audio.removeAttribute("src");
      return;
    }
    if (this.audio.src !== url) {
      this.audio.src = url;
      this.audio.currentTime = (this.pausedTime + this.win.start) / 1e6;
    }
  }

  /** Which part of the song is used: preview time 0 = song time `start`; stops at `length`. */
  setAudioWindow(w: { start: Micros; length: Micros; fadeIn: Micros; fadeOut: Micros }) {
    this.win = w;
    if (!this.playing) this.audio.currentTime = (this.pausedTime + w.start) / 1e6;
    this.applyVolume(this.time);
  }

  private applyVolume(t: Micros) {
    const { fadeIn, fadeOut, length } = this.win;
    let v = 1;
    if (fadeIn > 0) v = Math.min(v, t / fadeIn);
    if (fadeOut > 0 && length > 0) v = Math.min(v, (length - t) / fadeOut);
    this.audio.volume = Math.max(0, Math.min(1, v));
  }

  private get length(): Micros {
    if (this.timeline) return this.timeline.duration;
    if (this.win.length > 0) return this.win.length;
    return isFinite(this.audio.duration) ? this.audio.duration * 1e6 - this.win.start : 0;
  }

  setFramingOverride(o: { clipId: string; framing: Framing } | null) {
    this.framingOverride = o;
    this.needsDraw = true;
  }

  setTimeline(tl: Timeline | null) {
    this.timeline = tl;
    this.needsDraw = true;
  }

  setOptions(o: { keepClipAudio: boolean; clipAudioVolume: number; aspect: AspectRatio }) {
    this.keepClipAudio = o.keepClipAudio;
    this.clipAudioVolume = o.clipAudioVolume;
    if (o.aspect !== this.aspect) {
      this.aspect = o.aspect;
      this.resize();
    }
    this.needsDraw = true;
  }

  resize() {
    const a = aspectValue(this.aspect);
    const long = 960;
    const w = a >= 1 ? long : Math.round(long * a);
    const h = a >= 1 ? Math.round(long / a) : long;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.off = [];
    }
    this.needsDraw = true;
  }

  get time(): Micros {
    return this.playing ? Math.max(0, Math.round(this.audio.currentTime * 1e6) - this.win.start) : this.pausedTime;
  }

  isPlaying() {
    return this.playing;
  }

  async play() {
    if (!this.audio.src) return;
    if (this.pausedTime >= this.length - 10_000) this.seek(0);
    this.audio.currentTime = (this.pausedTime + this.win.start) / 1e6;
    this.applyVolume(this.pausedTime);
    try {
      await this.audio.play();
      this.playing = true;
    } catch (e) {
      this.playing = false;
      throw e;
    }
  }

  pause() {
    this.pausedTime = this.time;
    this.playing = false;
    this.audio.pause();
    this.pauseVideos();
    this.needsDraw = true;
  }

  seek(t: Micros) {
    this.pausedTime = Math.max(0, Math.min(t, this.length));
    this.audio.currentTime = (this.pausedTime + this.win.start) / 1e6;
    this.applyVolume(this.pausedTime);
    this.needsDraw = true;
    if (this.playing) for (const s of this.slots) if (!s.el.paused) s.el.pause();
  }

  private pauseVideos() {
    for (const s of this.slots) s.el.pause();
  }

  // ------------------------------------------------------------ main loop

  private loop() {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    let t = this.time;
    if (this.playing) {
      // Stop at the end of the used section of the song.
      if (t >= this.length) {
        t = this.length;
        this.audio.pause();
        this.playing = false;
        this.pausedTime = t;
        this.pauseVideos();
        this.onTime(t);
        this.onEnded();
      } else {
        this.applyVolume(t);
        this.onTime(t);
      }
    }
    if (this.playing || this.needsDraw) {
      this.needsDraw = false;
      this.renderAt(t);
    }
  }

  private slotFor(clip: TimelineClip, now: number): Slot | null {
    const m = this.sources.media(clip.mediaId);
    if (!m || m.kind !== "video") return null;
    let s = this.slots.find((x) => x.clipId === clip.id);
    if (s) {
      s.lastUsed = now;
      return s;
    }
    // Prefer a free slot already holding this media (no reload), then the least recently used.
    const candidates = this.slots.filter((x) => x.lastUsed < now);
    s = candidates.find((x) => x.mediaId === clip.mediaId) ?? candidates.sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!s) return null;
    s.clipId = clip.id;
    s.lastUsed = now;
    if (s.mediaId !== clip.mediaId) {
      const url = this.sources.url(clip.mediaId);
      s.mediaId = clip.mediaId;
      s.el.pause();
      if (url) s.el.src = url;
    }
    return s;
  }

  /** Source time (s) to show for clip at timeline time t — clamped like the export's tpad clone. */
  /** Source time (s) for clip at timeline time t — follows the clip's time map, clamped like the export. */
  private srcTime(clip: TimelineClip, t: Micros, m: MediaItem): number {
    return sourceTimeAt(timeMap(clip, m), (t - clip.start) / 1e6, Math.max(0, m.duration / 1e6 - 0.04));
  }

  private syncVideo(clip: TimelineClip, t: Micros, now: number, active: boolean): HTMLVideoElement | null {
    const m = this.sources.media(clip.mediaId);
    const slot = this.slotFor(clip, now);
    if (!slot || !m) return null;
    const el = slot.el;
    const want = this.srcTime(clip, t, m);
    if (el.readyState < 1) return el;
    const rate = segAt(timeMap(clip, m), (t - clip.start) / 1e6).rate;
    if (this.playing && active && rate < 0) {
      // Reverse playback: browsers can't play backwards, so step by seeking every frame.
      if (!el.paused) el.pause();
      el.muted = true;
      if (!el.seeking && Math.abs(el.currentTime - want) > 0.03) el.currentTime = want;
    } else if (this.playing && active) {
      const remapped = rate !== 1;
      el.muted = !this.keepClipAudio || remapped;
      el.volume = this.clipAudioVolume;
      const pr = Math.max(0.25, Math.min(4, rate));
      if (el.playbackRate !== pr) el.playbackRate = pr;
      if (el.paused) {
        if (Math.abs(el.currentTime - want) > 0.03) el.currentTime = want;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - want) > DRIFT_PLAYING) {
        el.currentTime = want;
      }
    } else {
      if (!el.paused) el.pause();
      el.muted = true;
      if (!el.seeking && Math.abs(el.currentTime - want) > 0.02) el.currentTime = want;
    }
    return el;
  }

  private image(mediaId: string): HTMLImageElement | null {
    let img = this.images.get(mediaId);
    if (!img) {
      const url = this.sources.url(mediaId);
      if (!url) return null;
      img = new Image();
      img.onload = () => (this.needsDraw = true);
      img.src = url;
      this.images.set(mediaId, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  renderAt(t: Micros) {
    this.frames++;
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const tl = this.timeline;
    if (!tl || !tl.clips.length) return;
    const now = performance.now();
    const clips = tl.clips;
    let i = clips.findIndex((c) => t >= c.start && t < c.end);
    if (i < 0) i = t >= tl.duration ? clips.length - 1 : 0;
    const cur = clips[i];

    // Transition windows are centred on cuts (same convention as export).
    let a: TimelineClip = cur, b: TimelineClip | null = null, p = 0, type: TransitionType = "cut";
    const into = cur.transitionIn;
    const next = clips[i + 1];
    if (i > 0 && into.type !== "cut" && t < cur.start + into.duration / 2) {
      a = clips[i - 1]; b = cur; type = into.type;
      p = (t - (cur.start - into.duration / 2)) / into.duration;
    } else if (next && next.transitionIn.type !== "cut" && t >= next.start - next.transitionIn.duration / 2) {
      a = cur; b = next; type = next.transitionIn.type;
      p = (t - (next.start - next.transitionIn.duration / 2)) / next.transitionIn.duration;
    }

    // Keep upcoming clips warm (pre-seeked, paused).
    for (let k = i + 1; k <= Math.min(clips.length - 1, i + 2); k++) {
      const c = clips[k];
      if (c === b) continue;
      const m = this.sources.media(c.mediaId);
      if (m?.kind === "video") {
        const s = this.slotFor(c, now);
        if (s && s.el.readyState >= 1 && s.el.paused && !s.el.seeking) {
          const lead = c.start - c.transitionIn.duration / 2;
          const want = this.srcTime(c, lead, m);
          if (Math.abs(s.el.currentTime - want) > 0.05) s.el.currentTime = want;
        }
      } else if (m?.kind === "image") this.image(c.mediaId);
    }

    const srcA = this.source(a, t, now, true);
    if (!b) {
      this.drawClip(srcA, a, t, 1);
    } else {
      const srcB = this.source(b, t, now, true);
      p = Math.max(0, Math.min(1, p));
      this.drawTransition(type, p, srcA, a, srcB, b, t);
    }
    // Pause videos that are no longer on screen.
    for (const s of this.slots) if (s.clipId !== a.id && s.clipId !== b?.id && !s.el.paused) s.el.pause();

    // Timeline fades (same formula as the export)
    const black = fadeAlpha(tl, t / 1e6);
    if (black > 0) {
      ctx.globalAlpha = Math.min(1, black);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  private source(clip: TimelineClip, t: Micros, now: number, active: boolean): CanvasImageSource | null {
    const m = this.sources.media(clip.mediaId);
    if (!m) return null;
    if (m.kind === "image") return this.image(m.id);
    const el = this.syncVideo(clip, t, now, active);
    return el && el.readyState >= 2 ? el : null;
  }

  private offscreen(i: number): CanvasRenderingContext2D {
    if (!this.off[i]) {
      const c = document.createElement("canvas");
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      this.off[i] = c;
    }
    return this.off[i].getContext("2d")!;
  }

  /** Draw a clip with all of its effects into `ctx` (defaults to the main canvas). Same order as the export graph. */
  private drawClip(src: CanvasImageSource | null, clip: TimelineClip, t: Micros, alpha: number, ctx = this.ctx) {
    const W = this.canvas.width, H = this.canvas.height;
    if (!src) return;
    const f: ClipFx = clipFx(clip);
    const tau = (t - clip.start) / 1e6;
    const { w: sw, h: sh } = srcSize(src);
    if (!sw || !sh) return;
    const z = zoomAt(f, tau);
    const sh2 = shakeAt(f, tau);
    // Framing window (same maths as the export's scale+crop), then zoom/shake about its centre.
    const framing = this.framingOverride?.clipId === clip.id ? this.framingOverride.framing : framingOf(clip);
    const r = framedRect(sw, sh, W, H, framing);
    const scale = r.k * z;
    const dw = sw * scale, dh = sh * scale;
    const dx = W / 2 + sh2.dx * W - (r.x + r.w / 2) * scale;
    const dy = H / 2 + sh2.dy * H - (r.y + r.h / 2) * scale;
    const dp = distortParams(f, W);
    const filters: string[] = [];
    if (f.distort > 0 || f.mono > 0) filters.push(`contrast(${dp.contrast}) saturate(${dp.saturation})`);
    if (f.hue > 0) filters.push(`hue-rotate(${hueAt(f, tau)}deg)`);
    const filter = filters.join(" ") || "none";
    const panels = splitPanels(f);
    const layered = dp.rgbShift > 0 || panels > 1 || f.prism > 0;

    if (!layered) {
      ctx.globalAlpha = alpha;
      ctx.filter = filter;
      ctx.drawImage(src, dx, dy, dw, dh);
      ctx.filter = "none";
    } else {
      // 1. graded frame → off[1]
      const out = this.offscreen(1);
      out.globalAlpha = 1;
      out.globalCompositeOperation = "source-over";
      out.fillStyle = "#000";
      out.fillRect(0, 0, W, H);
      if (dp.rgbShift > 0) {
        // RGB split: isolate channels with multiply, recombine additively with offsets.
        const base = this.offscreen(0);
        base.globalCompositeOperation = "source-over";
        base.filter = filter;
        base.fillStyle = "#000";
        base.fillRect(0, 0, W, H);
        base.drawImage(src, dx, dy, dw, dh);
        base.filter = "none";
        const ch = this.offscreen(2);
        const shifts: [string, number][] = [["#f00", -dp.rgbShift], ["#0f0", 0], ["#00f", dp.rgbShift]];
        for (const [color, sx] of shifts) {
          ch.globalCompositeOperation = "source-over";
          ch.drawImage(this.off[0], 0, 0);
          ch.globalCompositeOperation = "multiply";
          ch.fillStyle = color;
          ch.fillRect(0, 0, W, H);
          out.globalCompositeOperation = "lighter";
          out.drawImage(this.off[2], sx, 0);
        }
        out.globalCompositeOperation = "source-over";
      } else {
        out.filter = filter;
        out.drawImage(src, dx, dy, dw, dh);
        out.filter = "none";
      }
      if (dp.noise > 0) {
        out.globalAlpha = dp.noise / 120;
        out.globalCompositeOperation = "overlay";
        out.drawImage(this.noise, -Math.random() * 64, -Math.random() * 64, W + 64, H + 64);
        out.globalAlpha = 1;
        out.globalCompositeOperation = "source-over";
      }
      // 2. layout (split screen / prism) → off[3]
      let frame: HTMLCanvasElement = this.off[1];
      if (panels > 1 || f.prism > 0) {
        const lay = this.offscreen(3);
        lay.globalAlpha = 1;
        lay.globalCompositeOperation = "source-over";
        if (panels > 1) {
          const pw = splitPanelWidth(W, panels);
          const x = Math.floor((W - pw) / 4) * 2;
          for (let i = 0; i < panels; i++) lay.drawImage(this.off[1], x, 0, pw, H, (i * W) / panels, 0, W / panels, H);
        } else {
          lay.drawImage(this.off[1], 0, 0);
          lay.globalAlpha = Math.min(1, f.prism);
          const q = [W / 4, H / 4, W / 2, H / 2] as const;
          for (const [fx, fy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
            lay.save();
            lay.translate(W / 2, H / 2);
            lay.scale(fx, fy);
            lay.drawImage(this.off[1], ...q, -W / 2, -H / 2, W / 2, H / 2);
            lay.restore();
          }
          lay.globalAlpha = 1;
        }
        frame = this.off[3];
      }
      ctx.globalAlpha = alpha;
      ctx.drawImage(frame, 0, 0);
    }
    // 3. overlays
    const fl = flashAt(f, tau);
    if (fl > 0) {
      ctx.globalAlpha = alpha * fl;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
    }
    const bf = blackFadeAt(f, tau);
    if (bf > 0) {
      ctx.globalAlpha = alpha * bf;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }

  private drawTransition(
    type: TransitionType,
    p: number,
    srcA: CanvasImageSource | null,
    a: TimelineClip,
    srcB: CanvasImageSource | null,
    b: TimelineClip,
    t: Micros,
  ) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    switch (type) {
      case "fade":
        this.drawClip(srcA, a, t, 1);
        this.drawClip(srcB, b, t, p);
        break;
      case "fadeWhite":
      case "fadeBlack": {
        const color = type === "fadeWhite" ? "#fff" : "#000";
        if (p < 0.5) this.drawClip(srcA, a, t, 1);
        else this.drawClip(srcB, b, t, 1);
        ctx.globalAlpha = 1 - Math.abs(p - 0.5) * 2;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
        break;
      }
      case "slideLeft":
      case "slideUp": {
        const horiz = type === "slideLeft";
        ctx.save();
        ctx.translate(horiz ? -p * W : 0, horiz ? 0 : -p * H);
        this.drawClip(srcA, a, t, 1);
        ctx.restore();
        ctx.save();
        ctx.translate(horiz ? (1 - p) * W : 0, horiz ? 0 : (1 - p) * H);
        this.drawClip(srcB, b, t, 1);
        ctx.restore();
        break;
      }
      case "zoomIn": {
        this.drawClip(srcB, b, t, 1);
        ctx.save();
        const s = 1 + p;
        ctx.translate(W / 2, H / 2);
        ctx.scale(s, s);
        ctx.translate(-W / 2, -H / 2);
        this.drawClip(srcA, a, t, 1 - p);
        ctx.restore();
        break;
      }
      case "wipeLeft": {
        this.drawClip(srcA, a, t, 1);
        ctx.save();
        ctx.beginPath();
        ctx.rect((1 - p) * W, 0, p * W, H);
        ctx.clip();
        this.drawClip(srcB, b, t, 1);
        ctx.restore();
        break;
      }
      case "circleOpen": {
        this.drawClip(srcA, a, t, 1);
        ctx.save();
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, (p * Math.hypot(W, H)) / 2, 0, Math.PI * 2);
        ctx.clip();
        this.drawClip(srcB, b, t, 1);
        ctx.restore();
        break;
      }
      default:
        this.drawClip(p < 0.5 ? srcA : srcB, p < 0.5 ? a : b, t, 1);
    }
  }
}

function srcSize(src: CanvasImageSource): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight };
  const s = src as { width: number; height: number };
  return { w: s.width, h: s.height };
}

function makeNoise(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
