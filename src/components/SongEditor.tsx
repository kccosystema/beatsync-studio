"use client";
/**
 * Song section editor: pick the part of the song the video is cut to
 * (e.g. just the chorus). Shows the whole song with energy sections, lets the
 * user drag start/end (snapping to bar lines), suggests highlights (likely
 * chorus, best N seconds, detected sections), auditions the selection, and
 * sets music fades. Applying regenerates the edit from the chosen section.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, useStudio } from "@/store/studio";
import { barTimes, findHighlights, snapToBar, type Highlight } from "@/lib/audio/song";
import { formatTime } from "@/lib/time";
import type { Micros, SectionLabel } from "@/lib/types";
import { Button, Icon, IconButton, Slider, Toggle } from "./ui";
import { transport } from "./transport";

const SECTION_FILL: Record<SectionLabel, string> = {
  intro: "rgba(148,163,184,0.16)", low: "rgba(59,130,246,0.14)", mid: "rgba(139,92,246,0.16)", build: "rgba(234,179,8,0.18)",
  high: "rgba(236,72,153,0.18)", drop: "rgba(239,68,68,0.24)", breakdown: "rgba(34,211,238,0.14)", outro: "rgba(148,163,184,0.16)",
};
const MIN_LEN: Micros = 2_000_000;

type DragMode = { kind: "start" | "end" } | { kind: "move"; grab: Micros; s0: Micros; e0: Micros } | { kind: "new"; anchor: Micros };

export default function SongEditor({ onClose }: { onClose: () => void }) {
  const analysis = useStudio((s) => s.analysis);
  const audio = useStudio((s) => s.audio);
  const settings = useStudio((s) => s.settings);
  const update = useStudio((s) => s.updateSettings);
  const duration = analysis?.duration ?? 0;

  const [start, setStart] = useState<Micros>(settings.trimStart);
  const [end, setEnd] = useState<Micros>(settings.trimEnd || duration);
  const [fadeIn, setFadeIn] = useState<Micros>(settings.audioFadeIn);
  const [fadeOut, setFadeOut] = useState<Micros>(settings.audioFadeOut);
  const [snap, setSnap] = useState(true);
  const [playPos, setPlayPos] = useState<Micros | null>(null);
  const [drag, setDrag] = useState<DragMode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef(0);
  const [width, setWidth] = useState(800);

  const highlights = useMemo(() => (analysis ? findHighlights(analysis) : []), [analysis]);
  const bars = useMemo(() => (analysis ? barTimes(analysis) : []), [analysis]);
  const snapT = useCallback((t: Micros) => (snap && analysis ? snapToBar(analysis, t) : Math.round(t)), [snap, analysis]);

  // Stop the main preview while auditioning here.
  useEffect(() => {
    transport.pause();
    return () => {
      cancelAnimationFrame(rafRef.current);
      audioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ---- waveform drawing
  const H = 120;
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !analysis) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(H * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${H}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);
    const x = (t: Micros) => (t / duration) * width;
    for (const s of analysis.sections) {
      ctx.fillStyle = SECTION_FILL[s.label];
      ctx.fillRect(x(s.start), 0, x(s.end) - x(s.start), H);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    for (const b of bars) {
      const xx = Math.round(x(b)) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, H - 8); ctx.lineTo(xx, H); ctx.stroke();
    }
    const peaks = analysis.peaks;
    const per = peaks.length / width;
    const mid = H / 2;
    for (let px = 0; px < width; px++) {
      let m = 0;
      for (let i = Math.floor(px * per); i < Math.min(peaks.length, Math.floor((px + 1) * per) + 1); i++) m = Math.max(m, peaks[i]);
      const t = (px / width) * duration;
      const inside = t >= start && t < end;
      ctx.fillStyle = inside ? "#8b5cf6" : "rgba(147,153,171,0.35)";
      const h = Math.max(1, m * (H / 2 - 8));
      ctx.fillRect(px, mid - h, 1, h * 2);
    }
    // dim outside selection
    ctx.fillStyle = "rgba(11,11,14,0.45)";
    ctx.fillRect(0, 0, x(start), H);
    ctx.fillRect(x(end), 0, width - x(end), H);
    // fades
    ctx.strokeStyle = "rgba(34,211,238,0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x(start), H - 4);
    ctx.lineTo(x(start + fadeIn), 4);
    ctx.lineTo(x(end - fadeOut), 4);
    ctx.lineTo(x(end), H - 4);
    ctx.stroke();
    // play position
    if (playPos !== null) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(Math.round(x(playPos)), 0, 1.5, H);
    }
  }, [analysis, width, start, end, fadeIn, fadeOut, playPos, bars, duration]);

  const timeAt = (clientX: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    if (r.width <= 0) return start;
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  // ---- pointer interactions on the waveform
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const t = snapT(timeAt(e.clientX));
      if (drag.kind === "start") setStart(Math.min(t, end - MIN_LEN));
      else if (drag.kind === "end") setEnd(Math.max(t, start + MIN_LEN));
      else if (drag.kind === "move") {
        const len = drag.e0 - drag.s0;
        let s = snapT(drag.s0 + (timeAt(e.clientX) - drag.grab));
        s = Math.max(0, Math.min(duration - len, s));
        setStart(s);
        setEnd(Math.min(duration, s + len));
      } else if (drag.kind === "new") {
        const a = drag.anchor;
        if (Math.abs(t - a) >= MIN_LEN) { setStart(Math.min(a, t)); setEnd(Math.max(a, t)); }
      }
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, start, end, snapT, duration]);

  const onPointerDown = (e: React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    if (r.width <= 0) return;
    const px = e.clientX - r.left;
    const xs = (start / duration) * r.width, xe = (end / duration) * r.width;
    const t = timeAt(e.clientX);
    if (Math.abs(px - xs) < 9) setDrag({ kind: "start" });
    else if (Math.abs(px - xe) < 9) setDrag({ kind: "end" });
    else if (t > start && t < end) setDrag({ kind: "move", grab: t, s0: start, e0: end });
    else setDrag({ kind: "new", anchor: snapT(t) });
  };

  // ---- audition
  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
    setPlayPos(null);
  }, []);
  const play = async (from: Micros = start, to: Micros = end) => {
    if (!audio) return;
    stop();
    let el = audioRef.current;
    if (!el) { el = new Audio(assetUrl(audio.id)); audioRef.current = el; }
    el.currentTime = from / 1e6;
    try { await el.play(); } catch { return; }
    const tick = () => {
      const t = el!.currentTime * 1e6;
      if (t >= to || el!.paused) { stop(); return; }
      // the same fade curve the export applies
      let v = 1;
      if (fadeIn > 0) v = Math.min(v, (t - from) / fadeIn);
      if (fadeOut > 0) v = Math.min(v, (to - t) / fadeOut);
      el!.volume = Math.max(0, Math.min(1, v));
      setPlayPos(t);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const pick = (h: Highlight) => {
    setStart(h.start);
    setEnd(h.end);
    // musical defaults when cutting into the middle of a song
    setFadeIn(h.start > 0 ? 50_000 : 0);
    setFadeOut(h.end < duration ? 1_500_000 : 0);
  };
  const setLength = (secs: number) => {
    let e = snapT(start + secs * 1e6);
    if (e <= start + MIN_LEN) e = Math.min(duration, start + secs * 1e6);
    setEnd(Math.min(duration, e));
  };

  const apply = () => {
    stop();
    const whole = start <= 0 && end >= duration;
    update({
      trimStart: whole ? 0 : start,
      trimEnd: whole || end >= duration ? 0 : end,
      audioFadeIn: fadeIn,
      audioFadeOut: fadeOut,
    });
    transport.seek(0);
    onClose();
  };

  if (!analysis || !audio) return null;
  const len = end - start;
  const barCount = bars.filter((b) => b >= start && b < end).length;
  const isActive = (h: Highlight) => Math.abs(h.start - start) < 50_000 && Math.abs(h.end - end) < 50_000;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-4xl animate-pop flex-col rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()} data-testid="song-editor">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-white">Song section</h2>
            <p className="text-[11px] text-ink-400">Choose the part of “{audio.name}” to cut the video to. The edit is rebuilt from it.</p>
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>

        <div ref={wrapRef} className="relative w-full cursor-crosshair select-none overflow-hidden rounded-lg bg-ink-950 ring-1 ring-ink-700" onPointerDown={onPointerDown} data-testid="song-waveform">
          <canvas ref={canvasRef} className="block" />
          {/* handles */}
          {[start, end].map((t, i) => (
            <div key={i} className="pointer-events-none absolute top-0 h-full w-0.5 bg-volt" style={{ left: `${(t / duration) * 100}%` }}>
              <div className={`absolute top-1/2 h-8 w-2.5 -translate-y-1/2 rounded-sm bg-volt ${i === 0 ? "-left-1" : "-left-1"}`} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-500">
          <span>0:00</span><span>{formatTime(duration, false)}</span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="primary" onClick={() => (playPos !== null ? stop() : play())} data-testid="song-play">
            <Icon name={playPos !== null ? "stop" : "play"} size={13} /> {playPos !== null ? "Stop" : "Play selection"}
          </Button>
          <div className="font-mono text-xs text-ink-200" data-testid="song-range">
            {formatTime(start)} → {formatTime(end)} · <span className="text-white">{(len / 1e6).toFixed(1)}s</span> · {barCount} bars
          </div>
          <div className="flex items-center gap-1 text-[11px] text-ink-400">
            Length:
            {[15, 30, 60].filter((s) => s * 1e6 < duration).map((s) => (
              <button key={s} className="rounded-md bg-ink-800 px-2 py-0.5 text-ink-200 hover:bg-ink-700" onClick={() => setLength(s)}>{s}s</button>
            ))}
          </div>
          <div className="ml-auto w-36"><Toggle label="Snap to bars" checked={snap} onChange={setSnap} /></div>
        </div>

        <div className="mt-4 grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[1fr_220px]">
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Suggestions</div>
            <div className="grid gap-1.5 sm:grid-cols-2" data-testid="song-highlights">
              {highlights.map((h) => (
                <div
                  key={h.id}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition ${isActive(h) ? "border-violet/70 bg-violet/10" : h.kind === "chorus" ? "border-volt/40 bg-volt/5 hover:border-volt/70" : "border-ink-700 bg-ink-850 hover:border-ink-500"}`}
                >
                  <button className="min-w-0 flex-1 text-left" onClick={() => pick(h)} data-testid={`highlight-${h.id}`}>
                    <div className="flex items-center gap-1.5 text-xs font-medium text-white">
                      {h.kind === "chorus" && <Icon name="sparkles" size={12} className="text-volt" />}
                      {h.label}
                      <span className="font-mono text-[10px] font-normal text-ink-400">{formatTime(h.start, false)}–{formatTime(h.end, false)}</span>
                    </div>
                    <div className="truncate text-[10px] text-ink-400">{h.detail}</div>
                  </button>
                  <IconButton icon="play" size={12} label={`Listen to ${h.label}`} onClick={() => play(h.start, h.end)} />
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Music fades</div>
            <Slider label="Fade in" min={0} max={4} step={0.05} value={fadeIn / 1e6} onChange={(v) => setFadeIn(Math.round(v * 1e6))} format={(v) => `${v.toFixed(2)}s`} />
            <Slider label="Fade out" min={0} max={6} step={0.1} value={fadeOut / 1e6} onChange={(v) => setFadeOut(Math.round(v * 1e6))} format={(v) => `${v.toFixed(1)}s`} />
            <p className="text-[10px] leading-snug text-ink-500">Drag the handles or the selection on the waveform; drag anywhere else to draw a new one.</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-ink-800 pt-4">
          <Button variant="ghost" onClick={() => { setStart(0); setEnd(duration); setFadeIn(0); setFadeOut(0); }} data-testid="song-whole">Use whole song</Button>
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply} data-testid="song-apply"><Icon name="check" size={14} /> Use this section</Button>
        </div>
      </div>
    </div>
  );
}
