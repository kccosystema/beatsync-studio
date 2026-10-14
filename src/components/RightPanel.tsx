"use client";
import { useState } from "react";
import { selectedIndex, useStudio } from "@/store/studio";
import { PRESET_LIST } from "@/lib/engine/presets";
import { EFFECTS } from "@/lib/engine/effects";
import { TRANSITIONS } from "@/lib/engine/transitions";
import { GROUP_LABELS } from "./LeftPanel";
import { formatTime } from "@/lib/time";
import type { EditSettings, TransitionType } from "@/lib/types";
import { Button, Icon, IconButton, SectionTitle, Segmented, Slider, Toggle } from "./ui";
import { transport } from "./transport";

export default function RightPanel() {
  const idx = useStudio(selectedIndex);
  const [tab, setTab] = useState<"edit" | "clip">("edit");
  const [prevIdx, setPrevIdx] = useState(idx);
  if (idx !== prevIdx) {
    setPrevIdx(idx);
    if (idx >= 0) setTab("clip");
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-1.5 border-b border-ink-800">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[{ value: "edit", label: "Auto-Edit" }, { value: "clip", label: idx >= 0 ? `Clip ${idx + 1}` : "Clip" }]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{tab === "edit" ? <EditSettingsPanel /> : <ClipPanel />}</div>
    </div>
  );
}

export function EditSettingsPanel() {
  const s = useStudio((st) => st.settings);
  const update = useStudio((st) => st.updateSettings);
  const regenerate = useStudio((st) => st.regenerate);
  const generate = useStudio((st) => st.generate);
  const stats = useStudio((st) => st.stats);
  const timeline = useStudio((st) => st.timeline);
  const canGenerate = useStudio((st) => !!st.analysis && st.media.length > 0);
  const set = <K extends keyof EditSettings>(k: K) => (v: EditSettings[K]) => update({ [k]: v } as Partial<EditSettings>);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Button variant="primary" className="w-full" disabled={!canGenerate} onClick={() => (timeline ? regenerate() : generate())} data-testid="generate-btn">
          <Icon name={timeline ? "refresh" : "wand"} /> {timeline ? "Regenerate Edit" : "Generate Video"}
        </Button>
        {stats && timeline && (
          <div className="grid grid-cols-3 gap-1.5 text-center text-[10px] text-ink-400" data-testid="edit-stats">
            <div className="rounded-md bg-ink-850 py-1.5"><div className="font-mono text-sm text-white">{timeline.clips.length}</div>clips</div>
            <div className="rounded-md bg-ink-850 py-1.5"><div className="font-mono text-sm text-white">{stats.avgClipBeats}</div>avg beats</div>
            <div className="rounded-md bg-ink-850 py-1.5"><div className="font-mono text-sm text-white">{stats.transitions}</div>transitions</div>
          </div>
        )}
      </div>

      <section>
        <SectionTitle>Style</SectionTitle>
        <select
          value={s.preset}
          onChange={(e) => set("preset")(e.target.value as EditSettings["preset"])}
          className="w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 text-sm text-white outline-none focus:border-violet"
          data-testid="preset-select"
        >
          {PRESET_LIST.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </section>

      <section className="space-y-4">
        <SectionTitle>Pacing</SectionTitle>
        <Slider label="Editing intensity" value={s.intensity} onChange={set("intensity")} hint="Higher = shorter clips and faster cutting" />
        <Slider label="Transition frequency" value={s.transitionFrequency} onChange={set("transitionFrequency")} hint="How many cuts become transitions" />
        <Slider label="Effect intensity" value={s.effectIntensity} onChange={set("effectIntensity")} hint="Strength and amount of zooms, flashes and shake" />
        <div>
          <div className="mb-1.5 text-xs text-ink-300">Clip length</div>
          <Segmented<EditSettings["clipBeats"]>
            size="sm"
            value={s.clipBeats}
            onChange={set("clipBeats")}
            options={[
              { value: 0, label: "Auto", title: "Follow the preset and the song's energy" },
              { value: 1, label: "1" }, { value: 2, label: "2" }, { value: 4, label: "4" }, { value: 8, label: "8" }, { value: 16, label: "16" },
            ]}
          />
          <p className="mt-1 text-[10px] text-ink-500">Beats per clip. Fixed lengths still double in quiet parts and halve on drops.</p>
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle>Beat sync</SectionTitle>
        <Slider label="Sync offset" min={-150} max={150} step={5} value={Math.round(s.syncOffset / 1000)} onChange={(v) => set("syncOffset")(v * 1000)} format={(v) => `${v > 0 ? "+" : ""}${v} ms`} hint="Shift every cut earlier or later" />
        <div>
          <div className="mb-1.5 text-xs text-ink-300">Beat grid</div>
          <Segmented<EditSettings["tempoScale"]>
            size="sm"
            value={s.tempoScale}
            onChange={set("tempoScale")}
            options={[{ value: 0.5, label: "Half-time" }, { value: 1, label: "Detected" }, { value: 2, label: "Double-time" }]}
          />
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle>Clips</SectionTitle>
        <Segmented<EditSettings["order"]> size="sm" value={s.order} onChange={set("order")} options={[{ value: "sequential", label: "Sequential" }, { value: "shuffle", label: "Shuffled" }]} />
        <Slider label="Photo length" min={1} max={16} value={s.imageBeats} onChange={set("imageBeats")} format={(v) => `${v} beats`} />
        <Toggle label="Keep original clip audio" checked={s.keepClipAudio} onChange={set("keepClipAudio")} />
        {s.keepClipAudio && <Slider label="Clip audio level" value={Math.round(s.clipAudioVolume * 100)} onChange={(v) => set("clipAudioVolume")(v / 100)} format={(v) => `${v}%`} />}
      </section>

      <section className="space-y-2">
        <SectionTitle>Seed</SectionTitle>
        <div className="flex gap-2">
          <input
            type="number" min={1} value={s.seed}
            onChange={(e) => set("seed")(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            className="w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 font-mono text-sm text-white outline-none focus:border-violet"
            data-testid="seed-input"
          />
        </div>
        <p className="text-[10px] text-ink-500">Same seed + settings = the same edit, every time.</p>
      </section>
    </div>
  );
}

function ClipPanel() {
  const idx = useStudio(selectedIndex);
  const tl = useStudio((s) => s.timeline);
  const media = useStudio((s) => s.media);
  const grid = useStudio((s) => s.grid);
  const disabledFx = useStudio((s) => s.settings.disabledEffects);
  const st = useStudio.getState();
  if (!tl) return <p className="text-xs text-ink-400">Generate an edit first.</p>;
  if (idx < 0) {
    return (
      <div className="space-y-4">
        <p className="text-xs text-ink-400">Click a clip on the timeline to edit it.</p>
        <TimelineWide />
      </div>
    );
  }
  const clip = tl.clips[idx];
  const m = media.find((x) => x.id === clip.mediaId);
  const len = clip.end - clip.start;
  const beatLen = grid.length > 1 ? grid[1] - grid[0] : 500_000;
  const maxSrc = m && m.kind === "video" ? Math.max(0, m.duration - len) : 0;

  return (
    <div className="space-y-5" data-testid="clip-panel">
      <div className="flex items-center gap-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {m?.thumbnail && <img src={m.thumbnail} alt="" className="h-10 w-16 rounded object-cover" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white">{m?.name ?? "Missing media"}</div>
          <div className="font-mono text-[10px] text-ink-400">{formatTime(clip.start)} → {formatTime(clip.end)} · {(len / 1e6).toFixed(2)}s · ~{Math.max(1, Math.round(len / beatLen))} beats</div>
        </div>
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" className="flex-1" onClick={() => transport.seek(clip.start)}>Go to</Button>
        <Button size="sm" className="flex-1" onClick={() => st.duplicateClip(idx)}><Icon name="copy" size={13} /> Duplicate</Button>
        <Button size="sm" variant="danger" className="flex-1" onClick={() => st.removeClip(idx)}><Icon name="trash" size={13} /> Delete</Button>
      </div>

      <section className="space-y-2">
        <SectionTitle>Source</SectionTitle>
        <select
          value={clip.mediaId}
          onChange={(e) => st.replaceMedia(idx, e.target.value)}
          className="w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs text-white outline-none"
        >
          {media.map((x, i) => <option key={x.id} value={x.id}>{i + 1}. {x.name}</option>)}
        </select>
        {m?.kind === "video" && (
          <Slider
            label="Source in-point (slip)"
            min={0} max={Math.max(0.01, maxSrc / 1e6)} step={0.01}
            value={Math.min(clip.srcIn, maxSrc) / 1e6}
            onChange={(v) => st.slipClip(idx, Math.round(v * 1e6))}
            format={(v) => `${v.toFixed(2)}s`}
            hint="Choose which part of the source plays in this slot"
          />
        )}
        {m?.kind === "video" && clip.srcIn + len > m.duration && <p className="text-[10px] text-amber-300">Source is shorter than the slot — the last frame will be held.</p>}
      </section>

      <section className="space-y-2" data-testid="framing-section">
        <SectionTitle right={clip.framing ? <button className="text-[10px] text-violet-soft hover:text-white" onClick={() => st.setFraming(idx, null)}>Reset</button> : undefined}>Framing</SectionTitle>
        <Button
          size="sm" className="w-full"
          onClick={() => {
            if (st.playing) transport.pause();
            const t = transport.time();
            if (t < clip.start || t >= clip.end) transport.seek(clip.start + Math.round(len * 0.4));
            st.setAdjusting(clip.id);
          }}
        >
          <Icon name="sliders" size={13} /> Adjust in preview
        </Button>
        <Slider label="Horizontal" min={-1} max={1} step={0.01} value={clip.framing?.x ?? 0} format={(v) => (v === 0 ? "centre" : v < 0 ? `${Math.round(-v * 100)}% left` : `${Math.round(v * 100)}% right`)}
          onChange={(v) => st.setFraming(idx, { x: v, y: clip.framing?.y ?? 0, scale: clip.framing?.scale ?? 1 })} />
        <Slider label="Vertical" min={-1} max={1} step={0.01} value={clip.framing?.y ?? 0} format={(v) => (v === 0 ? "centre" : v < 0 ? `${Math.round(-v * 100)}% up` : `${Math.round(v * 100)}% down`)}
          onChange={(v) => st.setFraming(idx, { x: clip.framing?.x ?? 0, y: v, scale: clip.framing?.scale ?? 1 })} />
        <Slider label="Zoom" min={1} max={3} step={0.01} value={clip.framing?.scale ?? 1} format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => st.setFraming(idx, { x: clip.framing?.x ?? 0, y: clip.framing?.y ?? 0, scale: v })} />
      </section>

      <section className="space-y-2">
        <SectionTitle>Trim (move cuts)</SectionTitle>
        <div className="grid grid-cols-2 gap-1.5">
          <NudgeRow label="Start" disabled={idx === 0} onNudge={(d) => st.rollCut(idx, clip.start + d * beatLen, true)} />
          <NudgeRow label="End" disabled={idx === tl.clips.length - 1} onNudge={(d) => st.rollCut(idx + 1, clip.end + d * beatLen, true)} />
        </div>
        <p className="text-[10px] text-ink-500">Moves by one beat and snaps to the grid. Drag clip edges on the timeline for free trimming (hold Alt to disable snapping).</p>
      </section>

      <section className="space-y-2">
        <SectionTitle>Transition in</SectionTitle>
        <select
          disabled={idx === 0}
          value={clip.transitionIn.type}
          onChange={(e) => st.setTransition(idx, { type: e.target.value as TransitionType, duration: clip.transitionIn.duration || beatLen })}
          className="w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs text-white outline-none disabled:opacity-50"
          data-testid="transition-select"
        >
          {TRANSITIONS.map((t) => <option key={t.type} value={t.type}>{t.name}</option>)}
        </select>
        {clip.transitionIn.type !== "cut" && (
          <Slider
            label="Duration"
            min={0.1} max={4} step={0.25}
            value={Math.round((clip.transitionIn.duration / beatLen) * 4) / 4}
            onChange={(v) => st.setTransition(idx, { ...clip.transitionIn, duration: Math.round(v * beatLen) })}
            format={(v) => `${v} beats`}
          />
        )}
      </section>

      <section className="space-y-3">
        <SectionTitle right={disabledFx.length ? <span className="text-[10px] text-ink-500">{disabledFx.length} off for project</span> : undefined}>Effects</SectionTitle>
        {EFFECTS.filter((e) => !disabledFx.includes(e.type)).map((e, i, list) => {
          const fx = clip.effects.find((x) => x.type === e.type);
          const heading = i === 0 || list[i - 1].group !== e.group ? GROUP_LABELS[e.group] : null;
          return (
            <div key={e.type} className="space-y-1.5">
              {heading && <div className="pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{heading}</div>}
              <Toggle label={e.name} checked={!!fx} onChange={(on) => st.setEffect(idx, e.type, on ? 0.7 : null)} />
              {fx && <Slider label="Amount" value={Math.round(fx.intensity * 100)} onChange={(v) => st.setEffect(idx, e.type, v / 100)} format={(v) => `${v}%`} />}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function NudgeRow({ label, onNudge, disabled }: { label: string; onNudge: (d: number) => void; disabled?: boolean }) {
  return (
    <div className={`flex items-center justify-between rounded-lg border border-ink-700 bg-ink-850 px-1.5 py-1 ${disabled ? "opacity-40" : ""}`}>
      <IconButton icon="undo" label={`${label} one beat earlier`} disabled={disabled} onClick={() => onNudge(-1)} size={13} />
      <span className="text-[11px] text-ink-300">{label}</span>
      <IconButton icon="redo" label={`${label} one beat later`} disabled={disabled} onClick={() => onNudge(1)} size={13} />
    </div>
  );
}

function TimelineWide() {
  const tl = useStudio((s) => s.timeline)!;
  const setFades = useStudio((s) => s.setFades);
  const snapAll = useStudio((s) => s.snapAll);
  return (
    <section className="space-y-3">
      <SectionTitle>Whole timeline</SectionTitle>
      <Slider label="Fade in from black" min={0} max={8} step={0.25} value={tl.fadeIn / 1e6} onChange={(v) => setFades(Math.round(v * 1e6), tl.fadeOut)} format={(v) => `${v.toFixed(2)}s`} />
      <Slider label="Fade out to black" min={0} max={10} step={0.25} value={tl.fadeOut / 1e6} onChange={(v) => setFades(tl.fadeIn, Math.round(v * 1e6))} format={(v) => `${v.toFixed(2)}s`} />
      <Button size="sm" className="w-full" onClick={snapAll}><Icon name="magnet" size={13} /> Snap all cuts to beats</Button>
    </section>
  );
}
