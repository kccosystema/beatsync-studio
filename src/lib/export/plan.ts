/**
 * Export planner: translates the timeline's edit decisions into FFmpeg work.
 *
 * The output timeline is cut into "pieces" that tile it exactly:
 *
 *   body₀ | trans₁ | body₁ | trans₂ | body₂ | … | bodyₙ₋₁
 *
 * - A body piece is the part of one clip that no transition touches.
 * - A transition piece is a window centred on a cut, rendered from BOTH
 *   neighbouring clips (each with its own effects) and blended with xfade.
 *
 * Every piece is rendered straight from the source media at final quality with
 * an exact frame count, then all pieces are joined with the concat demuxer
 * (stream copy — no re-encode) and muxed with the song. All positions come
 * from one `frameAt` function, so each cut lands on the frame nearest its beat
 * and nothing accumulates drift.
 */
import type { AspectRatio, ExportSettings, MediaItem, RenderRequest, Timeline, TimelineClip } from "../types";
import { frameAt, outputSize } from "../time";
import {
  blackFadeExpr, clipFx, distortParams, flashExpr, hasFlash, hasMotion, hueExpr, shakeExpr,
  framingOf, splitPanels, timeMap, zoomExpr, type ClipFx,
} from "../engine/effects";
import { transitionMeta } from "../engine/transitions";

/** One FFmpeg input: a linear stretch of source footage (time-remapped clips use several). */
export interface PieceInput {
  clipIndex: number;
  mediaId: string;
  kind: MediaItem["kind"];
  /** Source time (s) to seek to (≥ 0). */
  srcStart: number;
  /** Source seconds to read (videos only). */
  srcDuration?: number;
  /** Frames to clone in front when the footage starts before the media does. */
  padStart: number;
  /** Output frames this input contributes. */
  frames: number;
  /** Playback rate: 1 normal, <1 slow-mo, >1 fast, <0 reversed. */
  rate: number;
}

/** One clip's contribution to a piece. */
export interface PieceSide {
  clipIndex: number;
  /** Clip-local time (s) of the piece's first frame. */
  localOffset: number;
  inputs: PieceInput[];
}

export interface Piece {
  index: number;
  kind: "body" | "transition";
  frameStart: number;
  frameCount: number;
  sides: PieceSide[];
  /** All FFmpeg inputs in order ([0:v], [1:v], …). */
  inputs: PieceInput[];
  /** filter_complex from [0:v] (and [1:v]) to [v]. */
  filter: string;
  /** xfade transition name for transition pieces. */
  xfade?: string;
}

export interface ClipSpan {
  index: number;
  mediaId: string;
  kind: MediaItem["kind"];
  /** Clip span in output frames — used for clip audio. */
  frameStart: number;
  frameCount: number;
  /** Source time (s) of the clip's first output frame. */
  srcStart: number;
  /** Clip uses a time effect; its original audio is not used. */
  remapped: boolean;
}

export interface RenderPlan {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  /** Exact output duration in seconds (totalFrames / fps). */
  totalSeconds: number;
  pieces: Piece[];
  clips: ClipSpan[];
  /** Transition frames at each clip start (0 = hard cut); index 0 unused. */
  transitionFrames: number[];
  /** Output frame of each cut (clip starts), index 0 = 0. */
  cutFrames: number[];
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const fx = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

export function planRender(req: Pick<RenderRequest, "timeline" | "media" | "aspect" | "export">): RenderPlan {
  const { timeline, aspect } = req;
  const { fps } = req.export;
  const { width, height } = outputSize(aspect, req.export.resolution);
  const clips = timeline.clips;
  const n = clips.length;
  if (!n) throw new Error("Timeline is empty");

  const bounds = clips.map((c) => frameAt(c.start, fps));
  bounds.push(frameAt(timeline.duration, fps));
  const totalFrames = bounds[n];
  for (let k = 0; k < n; k++) if (bounds[k + 1] <= bounds[k]) throw new Error(`Clip ${k + 1} is shorter than one frame at ${fps} fps`);

  // Transition frames per cut, clamped so every clip keeps ≥1 untouched body frame.
  const D: number[] = clips.map((c, k) => {
    if (k === 0 || c.transitionIn.type === "cut") return 0;
    const d = Math.round((c.transitionIn.duration * fps) / 1e6);
    return d >= 2 ? d : 0;
  });
  const head = (k: number) => Math.floor((D[k] ?? 0) / 2);
  const tail = (k: number) => (D[k] ?? 0) - head(k);
  // Left → right: clip k-1's tail is final when we reach cut k.
  for (let k = 1; k < n; k++) {
    if (!D[k]) continue;
    const prevRoom = bounds[k] - bounds[k - 1] - tail(k - 1) - 1; // frames of clip k-1 our head may use
    const nextRoom = bounds[k + 1] - bounds[k] - 1; // frames of clip k our tail may use
    const max = Math.min(2 * prevRoom + 1, 2 * nextRoom);
    if (D[k] > max) D[k] = max >= 2 ? max : 0;
  }

  const mediaById = new Map(req.media.map((m) => [m.id, m]));
  const getMedia = (k: number) => {
    const m = mediaById.get(clips[k].mediaId);
    if (!m) throw new Error(`Media ${clips[k].mediaId} missing for clip ${k + 1}`);
    return m;
  };
  const side = (k: number, frameStart: number, frameCount: number): PieceSide => {
    const clip = clips[k];
    const m = getMedia(k);
    const L0 = frameStart / fps - clip.start / 1e6;
    if (m.kind === "image") {
      return { clipIndex: k, localOffset: L0, inputs: [{ clipIndex: k, mediaId: m.id, kind: "image", srcStart: 0, padStart: 0, frames: frameCount, rate: 1 }] };
    }
    const D = m.duration / 1e6;
    const map = timeMap(clip, m);
    const inputs: PieceInput[] = [];
    for (const seg of map) {
      const j0 = Math.max(0, Math.min(frameCount, Math.ceil((seg.t0 - L0) * fps - 1e-6)));
      const j1 = Math.max(0, Math.min(frameCount, Math.ceil((seg.t1 - L0) * fps - 1e-6)));
      if (j1 <= j0) continue;
      const frames = j1 - j0;
      const tau0 = L0 + j0 / fps;
      // Unclamped source time of the sub-range's first frame.
      const rawStart = seg.t0 === -Infinity ? seg.src + tau0 * seg.rate : seg.src + (tau0 - seg.t0) * seg.rate;
      const span = (frames / fps) * Math.abs(seg.rate);
      if (seg.rate > 0) {
        const pad = rawStart < 0 ? Math.min(frames, Math.round((-rawStart / seg.rate) * fps)) : 0;
        const start = Math.max(0, Math.min(rawStart, Math.max(0, D - 1 / fps)));
        inputs.push({ clipIndex: k, mediaId: m.id, kind: "video", srcStart: start, srcDuration: span + 2 / fps, padStart: pad, frames, rate: seg.rate });
      } else {
        // reversed: read [end, start] and play it backwards
        const top = Math.max(0, Math.min(rawStart, D));
        const low = Math.max(0, top - span);
        inputs.push({ clipIndex: k, mediaId: m.id, kind: "video", srcStart: low, srcDuration: top - low + 1 / fps, padStart: 0, frames, rate: seg.rate });
      }
    }
    return { clipIndex: k, localOffset: L0, inputs };
  };
  const ctx = { width, height, fps, timeline, totalFrames };

  const pieces: Piece[] = [];
  const build = (kind: Piece["kind"], fs: number, count: number, sides: PieceSide[], name?: string): Piece => {
    let idx = 0;
    const graph: string[] = [];
    const outs = sides.map((sd, i) => {
      const label = `c${i}`;
      graph.push(sideGraph(clips[sd.clipIndex], sd, idx, `s${i}`, label, ctx));
      idx += sd.inputs.length;
      return label;
    });
    if (kind === "transition") {
      graph.push(`[${outs[0]}][${outs[1]}]xfade=transition=${name}:duration=${fx(count / fps)}:offset=0${fadeSuffix(fs, ctx)},format=yuv420p[v]`);
    } else {
      graph.push(`[${outs[0]}]null${fadeSuffix(fs, ctx)},format=yuv420p[v]`);
    }
    return { index: pieces.length, kind, frameStart: fs, frameCount: count, sides, inputs: sides.flatMap((x) => x.inputs), filter: graph.join(";"), xfade: name };
  };
  for (let k = 0; k < n; k++) {
    if (k > 0 && D[k]) {
      const fs = bounds[k] - head(k);
      const name = transitionMeta(clips[k].transitionIn.type).xfade ?? "fade";
      pieces.push(build("transition", fs, D[k], [side(k - 1, fs, D[k]), side(k, fs, D[k])], name));
    }
    const bs = bounds[k] + tail(k);
    const be = bounds[k + 1] - head(k + 1);
    pieces.push(build("body", bs, be - bs, [side(k, bs, be - bs)]));
  }

  const clipSpans: ClipSpan[] = clips.map((c, k) => ({
    index: k,
    mediaId: c.mediaId,
    kind: getMedia(k).kind,
    frameStart: bounds[k],
    frameCount: bounds[k + 1] - bounds[k],
    srcStart: c.srcIn / 1e6 + (bounds[k] / fps - c.start / 1e6),
    remapped: timeMap(c, getMedia(k)).some((seg) => seg.rate !== 1) || timeMap(c, getMedia(k)).length > 1,
  }));

  return { width, height, fps, totalFrames, totalSeconds: totalFrames / fps, pieces, clips: clipSpans, transitionFrames: D, cutFrames: bounds.slice(0, n) };
}

interface Ctx {
  width: number;
  height: number;
  fps: number;
  timeline: Timeline;
  totalFrames: number;
}

/**
 * Graph for one clip inside a piece: time-mapped source inputs → concat →
 * cover-crop → motion → grade → split/prism → hue → flash → black fade.
 * Inputs are [firstInput:v] … ; output is [outLabel].
 */
function sideGraph(clip: TimelineClip, sd: PieceSide, firstInput: number, p: string, outLabel: string, o: Ctx): string {
  const f = clipFx(clip);
  const g: string[] = [];
  const F = o.fps;
  // 1. sources: each sub-input becomes exactly `frames` frames at the output rate
  const subs = sd.inputs.map((inp, i) => {
    const c: string[] = [];
    if (inp.kind === "image") c.push(`fps=${F}`);
    else {
      c.push("setpts=PTS-STARTPTS");
      if (inp.rate < 0) c.push("reverse", "setpts=PTS-STARTPTS");
      if (Math.abs(inp.rate) !== 1) c.push(`setpts=PTS*${fx(1 / Math.abs(inp.rate))}`);
      c.push(`fps=${F}`);
      if (inp.padStart > 0) c.push(`tpad=start=${inp.padStart}:start_mode=clone`);
    }
    // Hold the last frame if the footage runs out early, then cut to the exact count.
    c.push("tpad=stop=-1:stop_mode=clone", `trim=end_frame=${inp.frames}`, "setsar=1", `settb=1/${F}`, "setpts=N");
    g.push(`[${firstInput + i}:v]${c.join(",")}[${p}i${i}]`);
    return `${p}i${i}`;
  });
  let cur = subs[0];
  if (subs.length > 1) {
    g.push(`${subs.map((x) => `[${x}]`).join("")}concat=n=${subs.length}:v=1:a=0,settb=1/${F},setpts=N[${p}cat]`);
    cur = `${p}cat`;
  }
  // 2. framing + motion + grade
  const motion = hasMotion(f);
  const S = motion ? 1.5 : 1;
  const sw = even(o.width * S), sh = even(o.height * S);
  // Framing: cover-scale (× manual zoom), then crop the window the user positioned.
  const fr = framingOf(clip);
  const c: string[] = [
    `scale=${even(sw * fr.scale)}:${even(sh * fr.scale)}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=bicubic`,
    `crop=${sw}:${sh}:'(iw-ow)/2*(1+(${fx(fr.x)}))':'(ih-oh)/2*(1+(${fx(fr.y)}))'`,
    `setsar=1`,
  ];
  const T = `(on/${F}+${fx(sd.localOffset)})`;
  const Tn = `(n/${F}+${fx(sd.localOffset)})`;
  if (motion) {
    const z = zoomExpr(f, T);
    const sk = shakeExpr(f, T);
    c.push(`zoompan=z='${z}':x='(iw-iw/zoom)/2-(${sk.dx})*iw/zoom':y='(ih-ih/zoom)/2-(${sk.dy})*ih/zoom':d=1:s=${o.width}x${o.height}:fps=${F}`);
  } else {
    c.push(`scale=${o.width}:${o.height}:flags=bicubic`);
  }
  c.push("format=yuv420p");
  const dp = distortParams(f, o.width);
  if (f.distort > 0 || f.mono > 0) c.push(`eq=contrast=${fx(dp.contrast)}:saturation=${fx(dp.saturation)}`);
  if (f.hue > 0) c.push(`hue=h='${hueExpr(f, Tn)}'`);
  if (dp.rgbShift > 0) c.push(`rgbashift=rh=-${dp.rgbShift}:bh=${dp.rgbShift}`, "format=yuv420p");
  if (f.distort > 0 && dp.noise > 0) c.push(`noise=alls=${dp.noise}:allf=t+u`);
  g.push(`[${cur}]${c.join(",")}[${p}g]`);
  cur = `${p}g`;
  // 3. layout effects
  if (splitPanels(f) > 1) {
    g.push(splitGraph(f, cur, `${p}sp`, p, o));
    cur = `${p}sp`;
  } else if (f.prism > 0) {
    g.push(prismGraph(f, cur, `${p}pr`, p, o));
    cur = `${p}pr`;
  }
  // 4. overlays (white flash, black fade)
  const post: string[] = [];
  if (hasFlash(f)) {
    const A = flashExpr(f, Tn);
    post.push(`eq=eval=frame:contrast='1-(${A})':brightness='(${A})/2':saturation='1-(${A})'`); // lerp to white
  }
  if (f.blackFade > 0) {
    const B = blackFadeExpr(f, Tn);
    post.push(`eq=eval=frame:contrast='1-(${B})':brightness='-(${B})/2':saturation='1-(${B})'`); // lerp to black
  }
  post.push(`settb=1/${F}`, "setpts=N");
  g.push(`[${cur}]${post.join(",")}[${outLabel}]`);
  return g.join(";");
}

/** Width of one split-screen panel (even) — the preview uses the same rounding. */
export const splitPanelWidth = (width: number, panels: number) => Math.max(2, Math.floor(width / panels / 2) * 2);

function splitGraph(f: ClipFx, inp: string, out: string, p: string, o: Ctx): string {
  const N = splitPanels(f);
  const w = splitPanelWidth(o.width, N);
  const x = Math.floor((o.width - w) / 4) * 2;
  const labels = Array.from({ length: N }, (_, i) => `[${p}q${i}]`).join("");
  return `[${inp}]crop=${w}:${o.height}:${x}:0,split=${N}${labels};${labels}hstack=inputs=${N},scale=${o.width}:${o.height},setsar=1[${out}]`;
}

function prismGraph(f: ClipFx, inp: string, out: string, p: string, o: Ctx): string {
  const W = o.width, H = o.height;
  const qw = W / 2, qh = H / 2;
  const mirror =
    `crop=${qw}:${qh}:${W / 4}:${H / 4},split=4[${p}m1][${p}m2][${p}m3][${p}m4];` +
    `[${p}m2]hflip[${p}m2f];[${p}m3]vflip[${p}m3f];[${p}m4]hflip,vflip[${p}m4f];` +
    `[${p}m1][${p}m2f]hstack[${p}mt];[${p}m3f][${p}m4f]hstack[${p}mb];[${p}mt][${p}mb]vstack,setsar=1`;
  if (f.prism >= 0.99) return `[${inp}]${mirror}[${out}]`;
  return `[${inp}]split=2[${p}po][${p}pm];[${p}pm]${mirror}[${p}pk];[${p}po][${p}pk]blend=all_mode=normal:all_opacity=${fx(f.prism)},format=yuv420p[${out}]`;
}

/** Timeline fade-in / fade-out to black, in absolute output time. Empty when the piece is outside both fades. */
function fadeSuffix(pieceStartFrame: number, o: Ctx): string {
  const fi = o.timeline.fadeIn / 1e6;
  const total = o.totalFrames / o.fps;
  const fo = Math.min(o.timeline.fadeOut / 1e6, total);
  const parts: string[] = [];
  const T = `((n+${pieceStartFrame})/${o.fps})`;
  if (fi > 0) parts.push(`max(0,1-${T}/${fx(fi)})`);
  if (fo > 0) parts.push(`max(0,(${T}-${fx(total - fo)})/${fx(fo)})`);
  if (!parts.length) return "";
  const A = `min(1,${parts.length === 2 ? `max(${parts[0]},${parts[1]})` : parts[0]})`;
  // lerp to black: y' = y(1-A)
  return `,eq=eval=frame:contrast='1-(${A})':brightness='-(${A})/2':saturation='1-(${A})'`;
}

/** Black-fade opacity at output time t (s) — the preview uses the same formula. */
export function fadeAlpha(tl: Timeline, t: number): number {
  const fi = tl.fadeIn / 1e6, fo = tl.fadeOut / 1e6, total = tl.duration / 1e6;
  let a = 0;
  if (fi > 0) a = Math.max(a, 1 - t / fi);
  if (fo > 0) a = Math.max(a, (t - (total - fo)) / fo);
  return Math.max(0, Math.min(1, a));
}

export function exportLabel(aspect: AspectRatio, e: ExportSettings) {
  const { width, height } = outputSize(aspect, e.resolution);
  return `${width}×${height} · ${e.fps} fps · H.264/AAC`;
}
