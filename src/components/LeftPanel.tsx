"use client";
import { useEffect, useRef, useState } from "react";
import { assetUrl, selectedIndex, useStudio } from "@/store/studio";
import { EFFECTS, type EffectGroup } from "@/lib/engine/effects";

export const GROUP_LABELS: Record<EffectGroup, string> = {
  motion: "Motion",
  look: "Look",
  time: "Time — one per clip (speed, slow-mo, boomerang, cuts)",
};
import { TRANSITIONS } from "@/lib/engine/transitions";
import { PRESET_LIST } from "@/lib/engine/presets";
import { formatTime } from "@/lib/time";
import { Button, Icon, IconButton, ProgressBar, SectionTitle, formatBytes } from "./ui";
import type { MediaItem } from "@/lib/types";

type Tab = "media" | "effects" | "transitions" | "presets";
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "media", icon: "film", label: "Media" },
  { id: "effects", icon: "sparkles", label: "Effects" },
  { id: "transitions", icon: "transition", label: "Transitions" },
  { id: "presets", icon: "layers", label: "Presets" },
];

export default function LeftPanel() {
  const [tab, setTab] = useState<Tab>("media");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 border-b border-ink-800 p-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex flex-1 flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium transition-colors ${tab === t.id ? "bg-ink-750 text-white" : "text-ink-400 hover:text-ink-100"}`}
          >
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "media" && <MediaTab />}
        {tab === "effects" && <EffectsTab />}
        {tab === "transitions" && <TransitionsTab />}
        {tab === "presets" && <PresetsTab />}
      </div>
    </div>
  );
}

export function MediaTab() {
  const audio = useStudio((s) => s.audio);
  const analysis = useStudio((s) => s.analysis);
  const analysisState = useStudio((s) => s.analysisState);
  const media = useStudio((s) => s.media);
  const importing = useStudio((s) => s.importing);
  const addFiles = useStudio((s) => s.addFiles);
  const removeAudio = useStudio((s) => s.removeAudio);
  const audioInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<MediaItem | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle>Music</SectionTitle>
        <input ref={audioInput} type="file" accept="audio/*,.mp3,.wav,.m4a,.aac" className="hidden" data-testid="audio-input"
          onChange={(e) => { if (e.target.files?.length) void addFiles([...e.target.files]); e.target.value = ""; }} />
        {!audio ? (
          <button
            onClick={() => audioInput.current?.click()}
            className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-ink-600 bg-ink-850 px-3 py-5 text-center transition hover:border-violet hover:bg-violet/5"
          >
            <Icon name="music" size={22} className="text-violet-soft" />
            <span className="text-sm text-ink-100">Add a song</span>
            <span className="text-[11px] text-ink-400">MP3 · WAV · M4A · AAC</span>
          </button>
        ) : (
          <div className="rounded-xl border border-ink-700 bg-ink-850 p-3">
            <div className="flex items-start gap-2.5">
              <div className="bs-grad flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white"><Icon name="music" /></div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white" title={audio.name}>{audio.name}</div>
                <div className="text-[11px] text-ink-400">{formatTime(audio.duration, false)} · {formatBytes(audio.size)}</div>
              </div>
              <IconButton icon="refresh" label="Replace song" onClick={() => audioInput.current?.click()} />
              <IconButton icon="trash" label="Remove song" onClick={removeAudio} />
            </div>
            {analysisState.state === "running" && (
              <div className="mt-3 space-y-1.5" data-testid="analysis-progress">
                <ProgressBar value={analysisState.progress} />
                <div className="text-[11px] text-ink-300">{analysisState.stage}…</div>
              </div>
            )}
            {analysisState.state === "error" && <div className="mt-2 text-[11px] text-red-300">{analysisState.error}</div>}
            {analysis && <SongSectionRow />}
            {analysis && (
              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center" data-testid="analysis-summary">
                <Stat label="BPM" value={analysis.bpm.toFixed(1)} />
                <Stat label="Beats" value={String(analysis.beats.length)} />
                <Stat label="Sections" value={String(analysis.sections.length)} />
                <div className="col-span-3 text-[10px] text-ink-400">
                  {analysis.method === "essentia" ? "Essentia.js RhythmExtractor2013" : "Built-in tracker"} · downbeats {analysis.downbeatsReliable ? "detected" : "estimated (low confidence)"}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <SectionTitle right={<span className="text-[11px] text-ink-400">{media.length} items</span>}>Clips & Photos</SectionTitle>
        <input ref={mediaInput} type="file" multiple accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp,.mov,.mp4,.webm" className="hidden" data-testid="media-input"
          onChange={(e) => { if (e.target.files?.length) void addFiles([...e.target.files]); e.target.value = ""; }} />
        <Button className="mb-3 w-full" onClick={() => mediaInput.current?.click()}>
          <Icon name="plus" /> Add clips or photos
        </Button>
        {importing > 0 && (
          <div className="mb-3 flex items-center gap-2 text-[11px] text-ink-300">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-violet border-t-transparent" /> Importing {importing} file{importing > 1 ? "s" : ""} — generating thumbnails…
          </div>
        )}
        <div className="grid grid-cols-2 gap-2" data-testid="media-grid">
          {media.map((m, i) => (
            <div
              key={m.id}
              draggable
              onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-beatsync-media", m.id); }}
              onDragOver={(e) => { if (dragIdx !== null) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragIdx !== null && dragIdx !== i) useStudio.getState().moveMedia(dragIdx, i); setDragIdx(null); }}
              onDragEnd={() => setDragIdx(null)}
              className={`group relative cursor-grab overflow-hidden rounded-lg border bg-ink-850 transition ${dragIdx === i ? "border-violet opacity-50" : "border-ink-700 hover:border-ink-500"}`}
            >
              <button className="block w-full" onClick={() => setPreview(m)} title={`${m.name}\n${m.width}×${m.height}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {m.thumbnail ? <img src={m.thumbnail} alt="" className="aspect-video w-full object-cover" /> : <div className="aspect-video w-full bg-ink-800" />}
              </button>
              <div className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white">
                <Icon name={m.kind === "video" ? "film" : "image"} size={10} />
                {m.kind === "video" ? formatTime(m.duration, false) : "Photo"}
              </div>
              <div className="absolute right-1 top-1 rounded bg-black/70 px-1 py-0.5 font-mono text-[9px] text-ink-200">{i + 1}</div>
              <button
                onClick={() => useStudio.getState().removeMedia(m.id)}
                aria-label={`Remove ${m.name}`}
                className="absolute bottom-6 right-1 hidden h-6 w-6 items-center justify-center rounded-md bg-black/75 text-ink-100 hover:bg-red-500/80 group-hover:flex"
              >
                <Icon name="x" size={12} />
              </button>
              <div className="flex items-center gap-1 px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate text-[10px] text-ink-300">{m.name}</span>
                {m.kind === "video" && (
                  <span className="h-1 w-6 overflow-hidden rounded-full bg-ink-700" title={`Motion ${Math.round((m.motion ?? 0) * 100)}%`}>
                    <span className="block h-full bg-volt" style={{ width: `${Math.round((m.motion ?? 0) * 100)}%` }} />
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        {media.length > 1 && <p className="mt-2 text-[10px] text-ink-500">Drag to reorder — sequential edits follow this order.</p>}
      </section>
      {preview && <MediaPreview item={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function SongSectionRow() {
  const s = useStudio((st) => st.settings);
  const duration = useStudio((st) => st.analysis?.duration ?? 0);
  const open = useStudio((st) => st.setSongEditorOpen);
  const update = useStudio((st) => st.updateSettings);
  const trimmed = s.trimStart > 0 || (s.trimEnd > 0 && s.trimEnd < duration);
  const end = s.trimEnd || duration;
  return (
    <div className="mt-3 space-y-1.5">
      {trimmed && (
        <div className="flex items-center gap-2 rounded-md bg-violet/10 px-2 py-1.5 text-[11px] text-violet-soft" data-testid="song-section-summary">
          <Icon name="scissors" size={12} />
          <span className="flex-1 font-mono">Using {formatTime(s.trimStart, false)}–{formatTime(end, false)} ({((end - s.trimStart) / 1e6).toFixed(1)}s)</span>
          <button className="text-ink-300 hover:text-white" title="Use the whole song" onClick={() => update({ trimStart: 0, trimEnd: 0, audioFadeIn: 0, audioFadeOut: 0 })}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <Button size="sm" className="w-full" onClick={() => open(true)} data-testid="open-song-editor">
        <Icon name="scissors" size={13} /> {trimmed ? "Change section" : "Trim song / find chorus"}
      </Button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-ink-800 px-1 py-1.5">
      <div className="font-mono text-sm text-white">{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-ink-400">{label}</div>
    </div>
  );
}

function MediaPreview({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const idx = useStudio(selectedIndex);
  const replace = useStudio((s) => s.replaceMedia);
  const url = assetUrl(item.id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl animate-pop rounded-2xl border border-ink-700 bg-ink-900 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-white">{item.name}</div>
            <div className="text-[11px] text-ink-400">
              {item.width}×{item.height} · {item.kind === "video" ? formatTime(item.duration) : "Photo"} · {formatBytes(item.size)}
              {item.kind === "video" && ` · motion ${Math.round((item.motion ?? 0) * 100)}%`}
            </div>
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        {item.kind === "video" ? (
          <video src={url} controls autoPlay muted className="max-h-[60vh] w-full rounded-lg bg-black" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={item.name} className="max-h-[60vh] w-full rounded-lg bg-black object-contain" />
        )}
        {idx >= 0 && (
          <div className="mt-3 flex justify-end">
            <Button variant="primary" onClick={() => { replace(idx, item.id); onClose(); }}>Use for selected clip</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function NeedsClip() {
  return <p className="mb-3 rounded-lg border border-ink-700 bg-ink-850 p-2.5 text-[11px] text-ink-300">Select a clip on the timeline to apply. Generated edits already place these automatically.</p>;
}

function EffectsTab() {
  const idx = useStudio(selectedIndex);
  const clip = useStudio((s) => (idx >= 0 ? s.timeline?.clips[idx] : undefined));
  const disabled = useStudio((s) => s.settings.disabledEffects);
  const setEffect = useStudio((s) => s.setEffect);
  const setEnabled = useStudio((s) => s.setEffectsEnabled);
  const all = EFFECTS.map((e) => e.type);
  const onCount = all.length - disabled.length;
  return (
    <div data-testid="effects-tab">
      <SectionTitle right={<span className="text-[11px] text-ink-400">{onCount} of {all.length} on</span>}>Effects library</SectionTitle>
      <p className="mb-2 text-[11px] leading-snug text-ink-400">
        Switch effects on or off for this project. Off effects are never used by the auto-editor and are removed from the edit.
        {clip ? " Click an effect to add it to the selected clip." : " Select a clip on the timeline to add effects to it by hand."}
      </p>
      <div className="mb-3 flex gap-1.5">
        <Button size="sm" className="flex-1" disabled={onCount === all.length} onClick={() => setEnabled(all, true)} data-testid="effects-all-on">All on</Button>
        <Button size="sm" className="flex-1" disabled={onCount === 0} onClick={() => setEnabled(all, false)} data-testid="effects-all-off">All off</Button>
      </div>
      <div className="space-y-1.5">
        {EFFECTS.map((e, i) => {
          const enabled = !disabled.includes(e.type);
          const on = clip?.effects.some((x) => x.type === e.type);
          const heading = i === 0 || EFFECTS[i - 1].group !== e.group ? GROUP_LABELS[e.group] : null;
          return (
            <div key={e.type}>
              {heading && <div className="mb-1.5 mt-3 text-[10px] font-semibold uppercase tracking-wider text-ink-500 first:mt-0">{heading}</div>}
              <div
                className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 transition ${on ? "border-violet/60 bg-violet/10" : "border-ink-700 bg-ink-850"} ${enabled ? "" : "opacity-50"}`}
                data-testid={`effect-row-${e.type}`}
              >
                <button
                  disabled={!clip || !enabled}
                  onClick={() => setEffect(idx, e.type, on ? null : 0.7)}
                  title={!enabled ? "Turned off for this project" : clip ? (on ? "Remove from selected clip" : "Add to selected clip") : "Select a clip to apply"}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left enabled:hover:text-white disabled:cursor-default"
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${on ? "bs-grad text-white" : "bg-ink-750 text-ink-300"}`}>
                    <Icon name={on ? "check" : "sparkles"} size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-ink-100">{e.name}</span>
                    <span className="block truncate text-[10px] text-ink-400">{enabled ? e.description : "Off for this project"}</span>
                  </span>
                </button>
                <Switch
                  checked={enabled}
                  onChange={(v) => setEnabled([e.type], v)}
                  label={`${enabled ? "Turn off" : "Turn on"} ${e.name} for this project`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-violet" : "bg-ink-600"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

function TransitionsTab() {
  const idx = useStudio(selectedIndex);
  const clip = useStudio((s) => (idx >= 0 ? s.timeline?.clips[idx] : undefined));
  const grid = useStudio((s) => s.grid);
  const setTransition = useStudio((s) => s.setTransition);
  const beat = grid.length > 2 ? grid[Math.floor(grid.length / 2) + 1] - grid[Math.floor(grid.length / 2)] : 500_000;
  return (
    <div>
      <SectionTitle>Transitions</SectionTitle>
      {!clip ? <NeedsClip /> : idx === 0 && <p className="mb-3 text-[11px] text-ink-400">The first clip has no incoming transition — use the fade-in in Clip settings.</p>}
      <div className="grid grid-cols-2 gap-1.5">
        {TRANSITIONS.map((t) => {
          const on = clip?.transitionIn.type === t.type;
          return (
            <button
              key={t.type}
              disabled={!clip || idx === 0}
              onClick={() => setTransition(idx, { type: t.type, duration: t.type === "cut" ? 0 : clip!.transitionIn.duration || beat })}
              className={`rounded-lg border px-2 py-2.5 text-left text-xs transition disabled:opacity-50 ${on ? "border-volt/60 bg-volt/10 text-white" : "border-ink-700 bg-ink-850 text-ink-200 hover:border-ink-500"}`}
            >
              <TransitionGlyph type={t.type} />
              <span className="mt-1.5 block font-medium">{t.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TransitionGlyph({ type }: { type: string }) {
  const map: Record<string, string> = {
    cut: "linear-gradient(90deg,#8b5cf6 50%,#22d3ee 50%)",
    fade: "linear-gradient(90deg,#8b5cf6,#22d3ee)",
    fadeWhite: "linear-gradient(90deg,#8b5cf6,#fff,#22d3ee)",
    fadeBlack: "linear-gradient(90deg,#8b5cf6,#000,#22d3ee)",
    slideLeft: "linear-gradient(90deg,#8b5cf6 30%,#22d3ee 30%)",
    slideUp: "linear-gradient(180deg,#8b5cf6 40%,#22d3ee 40%)",
    zoomIn: "radial-gradient(circle,#8b5cf6 30%,#22d3ee 70%)",
    wipeLeft: "linear-gradient(90deg,#8b5cf6 65%,#22d3ee 65%)",
    circleOpen: "radial-gradient(circle,#22d3ee 35%,#8b5cf6 36%)",
  };
  return <span className="block h-5 w-full rounded" style={{ background: map[type] }} />;
}

function PresetsTab() {
  const preset = useStudio((s) => s.settings.preset);
  const update = useStudio((s) => s.updateSettings);
  return (
    <div>
      <SectionTitle>Editing presets</SectionTitle>
      <div className="space-y-2">
        {PRESET_LIST.map((p) => (
          <button
            key={p.id}
            onClick={() => update({ preset: p.id })}
            className={`w-full rounded-xl border p-3 text-left transition ${preset === p.id ? "border-violet/70 bg-gradient-to-br from-violet/15 to-volt/5" : "border-ink-700 bg-ink-850 hover:border-ink-500"}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white">{p.name}</span>
              {preset === p.id && <Icon name="check" className="text-violet-soft" />}
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-ink-300">{p.tagline}</div>
            <div className="mt-2 flex gap-1 text-[9px] text-ink-400">
              <span className="rounded bg-ink-750 px-1.5 py-0.5">quiet: {p.lengths.low.beats.join("/")} beats</span>
              <span className="rounded bg-ink-750 px-1.5 py-0.5">drop: {p.lengths.peak.beats.join("/")} beats</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
