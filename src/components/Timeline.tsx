"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import { useEditAnalysis, useStudio } from "@/store/studio";
import { formatTime } from "@/lib/time";
import { nearestGridTime, rollCut, moveClip as moveClipOp, snapAllCuts } from "@/lib/timeline/ops";
import type { Micros, SectionLabel, Timeline as TL } from "@/lib/types";
import { transport } from "./transport";
import { Icon, IconButton } from "./ui";

const ROW = { ruler: 22, beats: 18, video: 60, audio: 54 };
const HEADER_W = 52;
const SECTION_COLORS: Record<SectionLabel, string> = {
  intro: "rgba(148,163,184,0.18)",
  low: "rgba(59,130,246,0.16)",
  mid: "rgba(139,92,246,0.18)",
  build: "rgba(234,179,8,0.20)",
  high: "rgba(236,72,153,0.20)",
  drop: "rgba(239,68,68,0.30)",
  breakdown: "rgba(34,211,238,0.16)",
  outro: "rgba(148,163,184,0.18)",
};

type Drag =
  | { kind: "trim"; index: number; startX: number; base: TL; current: TL; time: Micros }
  | { kind: "move"; index: number; startX: number; x: number; target: number; active: boolean }
  | { kind: "scrub" };

export default function Timeline({ compact = false }: { compact?: boolean }) {
  const timeline = useStudio((s) => s.timeline);
  const analysis = useEditAnalysis(); // trimmed song section (the whole song unless trimmed)
  const audio = useStudio((s) => s.audio);
  const grid = useStudio((s) => s.grid);
  const pps = useStudio((s) => s.pps);
  const media = useStudio((s) => s.media);
  const selectedClipId = useStudio((s) => s.selectedClipId);
  const syncOffset = useStudio((s) => s.settings.syncOffset);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const [scroll, setScroll] = useState({ left: 0, width: 800 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snap, setSnap] = useState(true);

  const duration = timeline?.duration ?? analysis?.duration ?? audio?.duration ?? 0;
  const contentW = Math.max(scroll.width, Math.ceil((duration / 1e6) * pps) + 40);
  const shown: TL | null = drag?.kind === "trim" ? drag.current : timeline;
  const mediaById = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const downbeatTimes = useMemo(() => {
    if (!analysis) return new Set<number>();
    return new Set(analysis.downbeatIndices.map((i) => analysis.beats[i] + syncOffset));
  }, [analysis, syncOffset]);

  // track viewport
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const update = () => setScroll({ left: el.scrollLeft, width: el.clientWidth });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);

  // fit zoom on first load of a song
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = audio && analysis ? `${audio.id}:${analysis.duration}` : null;
    if (!key || fittedFor.current === key || !scroll.width) return;
    fittedFor.current = key;
    useStudio.getState().setPps(Math.max(8, Math.min(120, (scroll.width - 60) / (analysis!.duration / 1e6))));
  }, [audio, analysis, scroll.width]);

  // background canvas: ruler, section bands, beat markers, beat grid — viewport-sized and redrawn on scroll
  useEffect(() => {
    const c = bgRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const H = ROW.ruler + ROW.beats + ROW.video + ROW.audio;
    c.width = Math.round(scroll.width * dpr);
    c.height = Math.round(H * dpr);
    c.style.width = `${scroll.width}px`;
    c.style.height = `${H}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, scroll.width, H);
    const t0 = (scroll.left / pps) * 1e6;
    const t1 = ((scroll.left + scroll.width) / pps) * 1e6;
    const x = (t: Micros) => (t / 1e6) * pps - scroll.left;

    // sections
    if (analysis) {
      for (const s of analysis.sections) {
        if (s.end < t0 || s.start > t1) continue;
        ctx.fillStyle = SECTION_COLORS[s.label];
        ctx.fillRect(x(s.start), 0, x(s.end) - x(s.start), ROW.ruler + ROW.beats);
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "600 9px ui-sans-serif, system-ui";
        const label = s.label.toUpperCase();
        if (x(s.end) - x(s.start) > 40) ctx.fillText(label, Math.max(4, x(s.start) + 4), ROW.ruler + ROW.beats - 5);
      }
    }
    // ruler ticks
    const stepCandidates = [0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = stepCandidates.find((s) => s * pps >= 64) ?? 60;
    ctx.fillStyle = "#9399ab";
    ctx.strokeStyle = "rgba(147,153,171,0.35)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.lineWidth = 1;
    for (let s = Math.floor(t0 / 1e6 / step) * step; s <= t1 / 1e6; s += step) {
      const xx = Math.round(s * pps - scroll.left) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xx, ROW.ruler - 8);
      ctx.lineTo(xx, ROW.ruler);
      ctx.stroke();
      ctx.fillText(formatTime(Math.round(s * 1e6), step < 1), xx + 3, 11);
    }
    // beats
    const yb = ROW.ruler;
    for (const b of grid) {
      if (b < t0 - 1e6 || b > t1 + 1e6) continue;
      const xx = Math.round(x(b)) + 0.5;
      const down = downbeatTimes.has(b);
      ctx.strokeStyle = down ? "rgba(34,211,238,0.95)" : "rgba(167,139,250,0.75)";
      ctx.beginPath();
      ctx.moveTo(xx, yb + (down ? 2 : 7));
      ctx.lineTo(xx, yb + ROW.beats - 2);
      ctx.stroke();
      // faint grid through the video track
      ctx.strokeStyle = down ? "rgba(34,211,238,0.12)" : "rgba(167,139,250,0.06)";
      ctx.beginPath();
      ctx.moveTo(xx, yb + ROW.beats);
      ctx.lineTo(xx, yb + ROW.beats + ROW.video);
      ctx.stroke();
    }
  }, [scroll, pps, grid, analysis, downbeatTimes]);

  // keep playhead in view while playing
  useEffect(() => {
    return useStudio.subscribe((s, prev) => {
      if (!s.playing || s.playhead === prev.playhead) return;
      const el = scrollRef.current;
      if (!el) return;
      const px = (s.playhead / 1e6) * s.pps;
      if (px > el.scrollLeft + el.clientWidth - 40 || px < el.scrollLeft) el.scrollLeft = px - 60;
    });
  }, []);

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current!;
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(duration, ((clientX - r.left + el.scrollLeft) / pps) * 1e6));
    },
    [pps, duration],
  );

  // ctrl/cmd + wheel zoom around the cursor
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const s = useStudio.getState();
      const r = el.getBoundingClientRect();
      const cursorT = (e.clientX - r.left + el.scrollLeft) / s.pps;
      const next = Math.max(4, Math.min(600, s.pps * Math.exp(-e.deltaY * 0.002)));
      s.setPps(next);
      requestAnimationFrame(() => (el.scrollLeft = cursorT * next - (e.clientX - r.left)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // pointer interactions
  useEffect(() => {
    if (!drag) return;
    const d = drag;
    const onMove = (e: PointerEvent) => {
      // A release we never saw (e.g. it happened before this listener attached): drop the stale drag.
      if (e.buttons === 0 && e.pointerType === "mouse") {
        setDrag(null);
        return;
      }
      if (d.kind === "scrub") transport.seek(timeAtClientX(e.clientX));
      else if (d.kind === "trim") {
        let t = timeAtClientX(e.clientX);
        if (snap && !e.altKey) t = nearestGridTime(t, useStudio.getState().grid);
        setDrag({ ...d, time: t, current: rollCut(d.base, d.index, t) });
      } else if (d.kind === "move") {
        const active = d.active || Math.abs(e.clientX - d.startX) > 5;
        const t = timeAtClientX(e.clientX);
        const tl = useStudio.getState().timeline!;
        let target = tl.clips.findIndex((c) => t >= c.start && t < c.end);
        if (target < 0) target = tl.clips.length - 1;
        setDrag({ ...d, x: e.clientX, active, target });
      }
    };
    const onUp = () => {
      setDrag(null);
      const st = useStudio.getState();
      if (d.kind === "trim" && d.current !== d.base) st.commit(d.current);
      if (d.kind === "move") {
        if (d.active && d.target !== d.index && st.timeline) {
          const moved = moveClipOp(st.timeline, d.index, d.target, st.grid);
          st.commit(snap ? snapAllCuts(moved, st.grid) : moved);
        }
        st.select(st.timeline?.clips[d.active ? d.target : d.index]?.id ?? null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, timeAtClientX, snap]);

  const zoom = (f: number) => {
    const el = scrollRef.current!;
    const s = useStudio.getState();
    const centerT = (el.scrollLeft + el.clientWidth / 2) / s.pps;
    const next = Math.max(4, Math.min(600, s.pps * f));
    s.setPps(next);
    requestAnimationFrame(() => (el.scrollLeft = centerT * next - el.clientWidth / 2));
  };
  const fit = () => {
    if (!duration) return;
    useStudio.getState().setPps(Math.max(4, (scroll.width - 40) / (duration / 1e6)));
    scrollRef.current!.scrollLeft = 0;
  };
  const nudgeOffset = (ms: number) => useStudio.getState().updateSettings({ syncOffset: syncOffset + ms * 1000 });

  const vTop = ROW.ruler + ROW.beats;
  const aTop = vTop + ROW.video;
  const totalH = aTop + ROW.audio;

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-900" data-testid="timeline">
      <div className="flex items-center gap-1 border-b border-ink-800 px-2 py-1">
        <IconButton icon="zoomOut" label="Zoom out" onClick={() => zoom(1 / 1.4)} />
        <input
          type="range" min={Math.log(4)} max={Math.log(600)} step={0.01} value={Math.log(pps)}
          onChange={(e) => useStudio.getState().setPps(Math.exp(Number(e.target.value)))}
          className="bs-range !w-24 sm:!w-32" aria-label="Timeline zoom"
          style={{ ["--fill" as string]: `${((Math.log(pps) - Math.log(4)) / (Math.log(600) - Math.log(4))) * 100}%` }}
        />
        <IconButton icon="zoomIn" label="Zoom in" onClick={() => zoom(1.4)} />
        <button onClick={fit} className="rounded-md px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-750 hover:text-white">Fit</button>
        <IconButton icon="magnet" label={snap ? "Snapping to beats (on)" : "Snapping off"} active={snap} onClick={() => setSnap(!snap)} />
        {!compact && analysis && (
          <div className="ml-2 hidden items-center gap-1 text-[11px] text-ink-400 md:flex">
            <span>Beat offset</span>
            <button className="rounded px-1.5 py-0.5 hover:bg-ink-750 hover:text-white" onClick={() => nudgeOffset(-10)} title="Shift beat grid 10 ms earlier">−10ms</button>
            <span className="w-12 text-center font-mono text-ink-200">{syncOffset >= 0 ? "+" : ""}{Math.round(syncOffset / 1000)}ms</span>
            <button className="rounded px-1.5 py-0.5 hover:bg-ink-750 hover:text-white" onClick={() => nudgeOffset(10)} title="Shift beat grid 10 ms later">+10ms</button>
          </div>
        )}
        <div className="flex-1" />
        {analysis && (
          <button
            onClick={() => useStudio.getState().setSongEditorOpen(true)}
            className="mr-2 flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-750 hover:text-white"
            title="Pick which part of the song to use"
          >
            <Icon name="scissors" size={12} /> Song section
          </button>
        )}
        {analysis && <span className="font-mono text-[11px] text-ink-400">{analysis.bpm.toFixed(1)} BPM · {grid.length} beats</span>}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* track headers */}
        <div className="shrink-0 border-r border-ink-800 bg-ink-900 text-[10px] font-semibold text-ink-400" style={{ width: HEADER_W }}>
          <div style={{ height: ROW.ruler }} />
          <div className="flex items-center justify-center" style={{ height: ROW.beats }}>BEATS</div>
          <div className="flex items-center justify-center gap-1 border-y border-ink-800" style={{ height: ROW.video }}><Icon name="film" size={12} />V1</div>
          <div className="flex items-center justify-center gap-1" style={{ height: ROW.audio }}><Icon name="music" size={12} />A1</div>
        </div>

        <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" data-testid="timeline-scroll">
          <div className="relative" style={{ width: contentW, height: totalH }}>
            <canvas ref={bgRef} className="pointer-events-none absolute top-0" style={{ left: scroll.left }} />
            {/* scrub zone: ruler + beat lane */}
            <div
              className="absolute left-0 right-0 top-0 cursor-col-resize"
              style={{ height: ROW.ruler + ROW.beats }}
              onPointerDown={(e) => { transport.seek(timeAtClientX(e.clientX)); setDrag({ kind: "scrub" }); }}
              data-testid="timeline-ruler"
            />
            {/* video track */}
            <div className="absolute left-0 right-0 border-y border-ink-800 bg-ink-850/40" style={{ top: vTop, height: ROW.video }}
              onPointerDown={(e) => { if (e.target === e.currentTarget) { useStudio.getState().select(null); transport.seek(timeAtClientX(e.clientX)); } }} />
            {shown?.clips.map((c, i) => {
              const m = mediaById.get(c.mediaId);
              const left = (c.start / 1e6) * pps;
              const width = Math.max(2, ((c.end - c.start) / 1e6) * pps);
              const selected = c.id === selectedClipId;
              const moving = drag?.kind === "move" && drag.active && drag.index === i;
              const isTarget = drag?.kind === "move" && drag.active && drag.target === i && drag.index !== i;
              return (
                <div
                  key={c.id}
                  data-testid="timeline-clip"
                  className={`group absolute overflow-hidden rounded-md border transition-[box-shadow,opacity] ${selected ? "z-10 border-white shadow-[0_0_0_2px_rgba(139,92,246,0.9)]" : "border-black/60"} ${moving ? "opacity-40" : ""} ${isTarget ? "shadow-[inset_0_0_0_2px_rgba(34,211,238,0.9)]" : ""}`}
                  style={{ left, width, top: vTop + 3, height: ROW.video - 6, backgroundColor: "#272a33", backgroundImage: m?.thumbnail ? `url(${m.thumbnail})` : undefined, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    useStudio.getState().select(c.id);
                    setDrag({ kind: "move", index: i, startX: e.clientX, x: e.clientX, target: i, active: false });
                  }}
                  title={`${m?.name ?? "?"} · ${((c.end - c.start) / 1e6).toFixed(2)}s${c.section ? ` · ${c.section}` : ""}`}
                >
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                  {width > 34 && (
                    <div className="pointer-events-none absolute bottom-0.5 left-1 right-1 flex items-center gap-1 text-[9px] font-medium text-white">
                      <span className="truncate">{i + 1}</span>
                      {c.effects.slice(0, 4).map((fx) => (
                        <span key={fx.type} className="rounded-sm bg-violet/80 px-0.5 text-[8px] uppercase" title={fx.type}>{fx.type.slice(0, 2)}</span>
                      ))}
                    </div>
                  )}
                  {/* trim handles (roll edit) */}
                  {i > 0 && (
                    <div
                      className="absolute bottom-0 left-0 top-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-volt/80"
                      onPointerDown={(e) => { e.stopPropagation(); const base = useStudio.getState().timeline!; setDrag({ kind: "trim", index: i, startX: e.clientX, base, current: base, time: c.start }); }}
                      data-testid="trim-handle"
                    />
                  )}
                  {i < (shown?.clips.length ?? 0) - 1 && (
                    <div
                      className="absolute bottom-0 right-0 top-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-volt/80"
                      onPointerDown={(e) => { e.stopPropagation(); const base = useStudio.getState().timeline!; setDrag({ kind: "trim", index: i + 1, startX: e.clientX, base, current: base, time: c.end }); }}
                    />
                  )}
                </div>
              );
            })}
            {/* transition indicators */}
            {shown?.clips.map((c, i) =>
              i > 0 && c.transitionIn.type !== "cut" ? (
                <div
                  key={`t-${c.id}`}
                  className="pointer-events-none absolute z-20 flex items-center justify-center rounded-sm border border-volt/80 bg-volt/25 text-[8px] font-bold text-white"
                  style={{ left: ((c.start - c.transitionIn.duration / 2) / 1e6) * pps, width: Math.max(6, (c.transitionIn.duration / 1e6) * pps), top: vTop + 1, height: 12 }}
                  title={c.transitionIn.type}
                  data-testid="transition-marker"
                >
                  {(c.transitionIn.duration / 1e6) * pps > 30 ? c.transitionIn.type.replace(/([A-Z])/g, " $1").toUpperCase() : ""}
                </div>
              ) : null,
            )}
            {drag?.kind === "trim" && (
              <div className="pointer-events-none absolute z-30 -translate-x-1/2 rounded bg-volt px-1.5 py-0.5 font-mono text-[10px] text-black" style={{ left: (drag.time / 1e6) * pps, top: vTop - 16 }}>
                {formatTime(drag.time)}
              </div>
            )}
            {/* audio lane */}
            <div className="absolute left-0" style={{ top: aTop, height: ROW.audio, width: (duration / 1e6) * pps }}
              onPointerDown={(e) => { transport.seek(timeAtClientX(e.clientX)); setDrag({ kind: "scrub" }); }}>
              {analysis && audio && <Waveform key={audio.id} peaks={analysis.peaks} duration={analysis.duration} pps={pps} />}
            </div>
            <Playhead height={totalH} pps={pps} />
          </div>
          {!audio && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-ink-500">Timeline appears once a song is added</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Playhead({ height, pps }: { height: number; pps: number }) {
  const playhead = useStudio((s) => s.playhead);
  return (
    <div className="pointer-events-none absolute top-0 z-40" style={{ transform: `translateX(${(playhead / 1e6) * pps}px)`, height }} data-testid="playhead">
      <div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-white" />
      <div className="absolute left-0 top-0 h-full w-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
    </div>
  );
}

function Waveform({ peaks, duration, pps }: { peaks: number[]; duration: Micros; pps: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const ws = useRef<WaveSurfer | null>(null);
  useEffect(() => {
    let cancelled = false;
    let instance: WaveSurfer | null = null;
    import("wavesurfer.js").then(({ default: WS }) => {
      if (cancelled || !ref.current) return;
      instance = WS.create({
        container: ref.current,
        height: ROW.audio - 6,
        waveColor: "#7c5cf0",
        progressColor: "#7c5cf0",
        cursorWidth: 0,
        interact: false,
        hideScrollbar: true,
        autoScroll: false,
        autoCenter: false,
        fillParent: true,
        minPxPerSec: pps,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true,
        peaks: [peaks],
        duration: duration / 1e6,
      });
      ws.current = instance;
    });
    return () => {
      cancelled = true;
      instance?.destroy();
      ws.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, duration]);
  useEffect(() => {
    try {
      ws.current?.zoom(pps);
    } catch {
      /* not ready yet */
    }
  }, [pps]);
  return <div ref={ref} className="h-full w-full pt-[3px]" data-testid="waveform" />;
}
