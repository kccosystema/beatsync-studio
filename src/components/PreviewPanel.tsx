"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { PreviewEngine } from "@/lib/preview/compositor";
import { assetUrl, selectedIndex, useStudio } from "@/store/studio";
import { framedRect, framingOf, FRAMING_MAX_SCALE } from "@/lib/engine/effects";
import { transport } from "./transport";
import { formatTime, aspectValue } from "@/lib/time";
import { Icon, IconButton, Segmented, Button } from "./ui";
import type { AspectRatio, Framing } from "@/lib/types";

export default function PreviewPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const timeline = useStudio((s) => s.timeline);
  const audio = useStudio((s) => s.audio);
  const settings = useStudio((s) => s.settings);
  const playing = useStudio((s) => s.playing);
  const media = useStudio((s) => s.media);
  const analysis = useStudio((s) => s.analysis);
  const mediaRef = useRef(media);
  useEffect(() => {
    mediaRef.current = media;
  }, [media]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const engine = new PreviewEngine(
      canvas,
      { url: (id) => assetUrl(id), media: (id) => mediaRef.current.find((m) => m.id === id) },
      (t) => useStudio.getState().setPlayhead(t),
      () => {
        useStudio.getState().setPlaying(false);
      },
    );
    engine.resize();
    engineRef.current = engine;
    transport.attach(engine);
    (window as unknown as { __beatsyncPreview?: PreviewEngine }).__beatsyncPreview = engine;
    return () => {
      transport.attach(null);
      engine.destroy();
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setAudio(audio ? assetUrl(audio.id) : undefined);
  }, [audio]);
  useEffect(() => {
    engineRef.current?.setTimeline(timeline);
  }, [timeline, media]);
  useEffect(() => {
    const songLen = analysis?.duration ?? audio?.duration ?? 0;
    const start = Math.min(settings.trimStart, songLen);
    const end = settings.trimEnd || songLen;
    engineRef.current?.setAudioWindow({ start, length: Math.max(0, end - start), fadeIn: settings.audioFadeIn, fadeOut: settings.audioFadeOut });
  }, [analysis, audio, settings.trimStart, settings.trimEnd, settings.audioFadeIn, settings.audioFadeOut]);
  useEffect(() => {
    engineRef.current?.setOptions({ keepClipAudio: settings.keepClipAudio, clipAudioVolume: settings.clipAudioVolume, aspect: settings.aspect });
  }, [settings.keepClipAudio, settings.clipAudioVolume, settings.aspect]);

  const fullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const a = aspectValue(settings.aspect);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center bg-ink-950 p-3 [&:fullscreen]:bg-black [&:fullscreen]:p-0">
        <div className="relative max-h-full max-w-full" style={{ aspectRatio: String(a), height: a >= 1 ? undefined : "100%", width: a >= 1 ? "100%" : undefined }}>
          <canvas
            ref={canvasRef}
            data-testid="preview-canvas"
            onClick={() => timeline && transport.toggle()}
            className="block h-full max-h-full w-full max-w-full rounded-md bg-black object-contain shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] ring-1 ring-ink-700"
          />
          {!timeline && <EmptyOverlay hasAudio={!!audio} hasMedia={media.length > 0} analyzing={!!audio && !analysis} />}
          {timeline && <ClipAdjust canvasRef={canvasRef} />}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-ink-800 bg-ink-900 px-3 py-2">
        <IconButton icon="skipBack" label="Back to start (Home)" onClick={() => transport.seek(0)} disabled={!audio} />
        <button
          onClick={() => transport.toggle()}
          disabled={!audio}
          aria-label={playing ? "Pause (Space)" : "Play (Space)"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          className="bs-grad inline-flex h-9 w-9 items-center justify-center rounded-full text-white shadow-lg transition hover:brightness-110 disabled:opacity-40"
        >
          <Icon name={playing ? "pause" : "play"} size={16} />
        </button>
        <Timecode />
        <div className="flex-1" />
        <div className="hidden sm:block w-48">
          <Segmented<AspectRatio>
            size="sm"
            value={settings.aspect}
            onChange={(aspect) => useStudio.getState().updateSettings({ aspect })}
            options={[{ value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" }, { value: "1:1", label: "1:1" }]}
          />
        </div>
        <IconButton icon="fullscreen" label="Fullscreen preview" onClick={fullscreen} />
      </div>
    </div>
  );
}

function Timecode() {
  const playhead = useStudio((s) => s.playhead);
  const duration = useStudio((s) => s.timeline?.duration ?? (s.audio ? (s.settings.trimEnd || s.audio.duration) - s.settings.trimStart : 0));
  return (
    <div className="font-mono text-xs tabular-nums text-ink-200" data-testid="timecode">
      <span className="text-white">{formatTime(playhead)}</span>
      <span className="text-ink-500"> / {formatTime(duration)}</span>
    </div>
  );
}

function EmptyOverlay({ hasAudio, hasMedia, analyzing }: { hasAudio: boolean; hasMedia: boolean; analyzing: boolean }) {
  const generate = useStudio((s) => s.generate);
  const ready = hasAudio && hasMedia && !analyzing;
  const steps = [
    { done: hasAudio, label: "Add a song", sub: "MP3, WAV, M4A or AAC" },
    { done: hasMedia, label: "Add video clips or photos", sub: "MP4, MOV, WebM, JPG, PNG, WebP" },
    { done: false, label: "Generate the edit", sub: "Cuts land on the beat automatically" },
  ];
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 rounded-md bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.12),transparent_70%)] p-6 text-center">
      <div>
        <div className="text-lg font-semibold text-white">Make a music video in one click</div>
        <div className="mt-1 text-sm text-ink-300">Drop files anywhere in the window to get started.</div>
      </div>
      <ol className="flex flex-col gap-2 text-left">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-3">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${s.done ? "bg-emerald-500/20 text-emerald-300" : "bg-ink-700 text-ink-300"}`}>
              {s.done ? <Icon name="check" size={13} /> : i + 1}
            </span>
            <span>
              <span className="block text-sm text-ink-100">{s.label}</span>
              <span className="block text-[11px] text-ink-400">{s.sub}</span>
            </span>
          </li>
        ))}
      </ol>
      <Button variant="primary" disabled={!ready} onClick={generate}>
        <Icon name="wand" /> Generate Video
      </Button>
    </div>
  );
}

/**
 * Selected-clip toolbar over the preview, and the "Adjust" mode that lets the
 * user drag/zoom the clip inside the output frame (e.g. reframe 16:9 footage
 * for a 9:16 edit). Drags preview live via an engine override and commit one
 * undoable timeline edit on release.
 */
function ClipAdjust({ canvasRef }: { canvasRef: RefObject<HTMLCanvasElement | null> }) {
  const idx = useStudio(selectedIndex);
  const clip = useStudio((s) => (idx >= 0 ? s.timeline?.clips[idx] : undefined));
  const media = useStudio((s) => s.media.find((m) => m.id === clip?.mediaId));
  const adjusting = useStudio((s) => !!clip && s.adjustingClipId === clip.id);
  const playing = useStudio((s) => s.playing);
  const aspect = useStudio((s) => s.settings.aspect);
  const [live, setLive] = useState<Framing | null>(null);
  const drag = useRef<{ x: number; y: number; start: Framing } | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Starting playback leaves adjust mode.
  useEffect(() => {
    if (playing && adjusting) useStudio.getState().setAdjusting(null);
  }, [playing, adjusting]);

  if (!clip || !media) return null;
  const framing = live ?? framingOf(clip);
  // Preview canvas size (mirrors PreviewEngine.resize: 960 px on the long side).
  const av = aspectValue(aspect);
  const W = av >= 1 ? 960 : Math.round(960 * av), H = av >= 1 ? Math.round(960 / av) : 960;
  const r = framedRect(media.width, media.height, W, H, framing);
  const ovX = (media.width * r.k - W) / 2; // half overflow in canvas px
  const ovY = (media.height * r.k - H) / 2;
  const canMove = ovX > 0.5 || ovY > 0.5;
  const moved = framing.x !== 0 || framing.y !== 0 || framing.scale !== 1;

  const st = useStudio.getState;
  const preview = (f: Framing) => {
    setLive(f);
    transport.setFramingOverride({ clipId: clip.id, framing: f });
  };
  const commit = (f: Framing | null) => {
    st().setFraming(idx, f);
    setLive(null);
    transport.setFramingOverride(null);
  };
  const enter = () => {
    if (st().playing) transport.pause();
    const t = transport.time();
    if (t < clip.start || t >= clip.end) transport.seek(clip.start + Math.round((clip.end - clip.start) * 0.4));
    st().setAdjusting(clip.id);
  };
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));

  if (!adjusting) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center" data-testid="clip-toolbar">
        <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-ink-600 bg-ink-900/90 px-2 py-1 text-xs shadow-xl backdrop-blur">
          <span className="px-1.5 text-ink-300">Clip {idx + 1}</span>
          <Button size="sm" variant="primary" onClick={enter} data-testid="adjust-btn">
            <Icon name="sliders" size={13} /> Adjust
          </Button>
          {moved && (
            <Button size="sm" variant="ghost" onClick={() => commit(null)} title="Re-centre this clip">Reset framing</Button>
          )}
        </div>
      </div>
    );
  }

  const toCanvas = (clientDx: number, clientDy: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { dx: (clientDx * W) / rect.width, dy: (clientDy * H) / rect.height };
  };

  return (
    <div
      className="absolute inset-0 cursor-grab touch-none rounded-md ring-2 ring-volt active:cursor-grabbing"
      data-testid="adjust-overlay"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, start: framing };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const { dx, dy } = toCanvas(e.clientX - d.x, e.clientY - d.y);
        // Same geometry as the renderer: dragging right moves the window left (x decreases).
        const sr = framedRect(media.width, media.height, W, H, d.start);
        const ox = (media.width * sr.k - W) / 2, oy = (media.height * sr.k - H) / 2;
        preview({
          ...d.start,
          x: ox > 0.5 ? clamp(d.start.x - dx / ox) : d.start.x,
          y: oy > 0.5 ? clamp(d.start.y - dy / oy) : d.start.y,
        });
      }}
      onPointerUp={() => {
        if (drag.current && live) commit(live);
        drag.current = null;
      }}
      onWheel={(e) => {
        const scale = Math.max(1, Math.min(FRAMING_MAX_SCALE, framing.scale * Math.exp(-e.deltaY * 0.0015)));
        const next = { ...framing, scale };
        preview(next);
        if (wheelTimer.current) clearTimeout(wheelTimer.current);
        wheelTimer.current = setTimeout(() => commit(next), 250);
      }}
    >
      {/* toolbar */}
      <div className="absolute inset-x-0 top-2 flex justify-center" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-600 bg-ink-900/90 px-2.5 py-1.5 text-xs shadow-xl backdrop-blur">
          <span className="text-ink-200">Clip {idx + 1}: drag to position{media.kind === "video" || media.kind === "image" ? ", scroll to zoom" : ""}</span>
          <label className="flex items-center gap-1.5 text-ink-400">
            Zoom
            <input
              type="range" className="bs-range !w-20" min={1} max={FRAMING_MAX_SCALE} step={0.01} value={framing.scale}
              style={{ ["--fill" as string]: `${((framing.scale - 1) / (FRAMING_MAX_SCALE - 1)) * 100}%` }}
              onChange={(e) => preview({ ...framing, scale: Number(e.target.value) })}
              onPointerUp={() => live && commit(live)}
              aria-label="Framing zoom"
              data-testid="adjust-zoom"
            />
            <span className="w-9 font-mono text-ink-200">{framing.scale.toFixed(2)}×</span>
          </label>
          <Button size="sm" variant="ghost" onClick={() => commit(null)} disabled={!moved} data-testid="adjust-reset">Reset</Button>
          <Button size="sm" variant="primary" onClick={() => { if (live) commit(live); st().setAdjusting(null); }} data-testid="adjust-done">
            <Icon name="check" size={13} /> Done
          </Button>
        </div>
      </div>
      {!canMove && (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 text-center text-[11px] text-ink-200 drop-shadow">
          This clip already fits the {aspect} frame exactly; zoom in to reposition it.
        </div>
      )}
      {/* minimap: whole source, highlighted visible window */}
      <Minimap srcW={media.width} srcH={media.height} rect={r} />
    </div>
  );
}

function Minimap({ srcW, srcH, rect }: { srcW: number; srcH: number; rect: { x: number; y: number; w: number; h: number } }) {
  const maxW = 110, maxH = 80;
  const s = Math.min(maxW / srcW, maxH / srcH);
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 rounded-md border border-ink-600 bg-black/70 p-1.5" data-testid="adjust-minimap">
      <div className="relative bg-ink-700" style={{ width: srcW * s, height: srcH * s }}>
        <div
          className="absolute border-2 border-volt bg-volt/20"
          style={{ left: rect.x * s, top: rect.y * s, width: rect.w * s, height: rect.h * s }}
        />
      </div>
      <div className="mt-1 text-center text-[9px] uppercase tracking-wide text-ink-400">In frame</div>
    </div>
  );
}
