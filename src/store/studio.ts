"use client";
/**
 * Application state (Zustand). The timeline here is the single edit-decision
 * list that the timeline UI, preview renderer and export engine all consume.
 */
import { create } from "zustand";
import type {
  Framing,
  AudioAsset,
  BeatAnalysis,
  EditSettings,
  EffectType,
  ExportSettings,
  MediaItem,
  Micros,
  Timeline,
  Transition,
} from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { buildGrid, generateTimeline, type GenerateStats } from "@/lib/engine/generate";
import * as ops from "@/lib/timeline/ops";
import { classify, importVisual, mapLimit, MAX_MEDIA, newId, probeAudio } from "@/lib/media/import";
import { analyzeFile } from "@/lib/audio/client";
import { sliceAnalysis } from "@/lib/audio/song";
import { loadProject, saveProject, type ProjectDoc } from "@/lib/persist/db";

// ---------------------------------------------------------------- asset registry
// Files and object URLs live outside React state; state only holds ids.
const files = new Map<string, Blob>();
const urls = new Map<string, string>();
export const assetUrl = (id: string) => urls.get(id);
export const assetBlob = (id: string) => files.get(id);
function registerAsset(id: string, blob: Blob, url?: string) {
  files.set(id, blob);
  urls.set(id, url ?? URL.createObjectURL(blob));
}
function releaseAsset(id: string) {
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  files.delete(id);
}

// ---------------------------------------------------------------- trimmed song
let sliceCache: { a: BeatAnalysis; s: Micros; e: Micros; out: BeatAnalysis } | null = null;
/** The analysis of the part of the song being used (the whole song unless trimmed). Stable identity per input. */
export function editAnalysisOf(a: BeatAnalysis | null, settings: EditSettings): BeatAnalysis | null {
  if (!a) return null;
  const s = settings.trimStart || 0, e = settings.trimEnd || a.duration;
  if (s <= 0 && e >= a.duration) return a;
  if (sliceCache && sliceCache.a === a && sliceCache.s === s && sliceCache.e === e) return sliceCache.out;
  const out = sliceAnalysis(a, s, e);
  sliceCache = { a, s, e, out };
  return out;
}
export const useEditAnalysis = () => useStudio((s) => editAnalysisOf(s.analysis, s.settings));

export interface Toast {
  id: string;
  kind: "info" | "error" | "success";
  text: string;
}

type AnalysisState =
  | { state: "idle" }
  | { state: "running"; progress: number; stage: string }
  | { state: "done" }
  | { state: "error"; error: string };

const HISTORY_LIMIT = 100;

export interface StudioState {
  projectId: string;
  projectName: string;
  dirty: boolean;
  lastSavedAt: number | null;

  audio: AudioAsset | null;
  analysis: BeatAnalysis | null;
  analysisState: AnalysisState;
  media: MediaItem[];
  importing: number;

  settings: EditSettings;
  exportSettings: ExportSettings;
  timeline: Timeline | null;
  grid: Micros[];
  stats: GenerateStats | null;
  past: Timeline[];
  future: Timeline[];
  /** True once the user has hand-edited the current generated timeline. */
  editedSinceGenerate: boolean;

  selectedClipId: string | null;
  playhead: Micros;
  playing: boolean;
  /** Timeline zoom: pixels per second. */
  pps: number;
  toasts: Toast[];

  // actions
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: string) => void;
  addFiles: (files: File[]) => Promise<void>;
  setAudio: (file: File) => Promise<void>;
  removeMedia: (id: string) => void;
  moveMedia: (from: number, to: number) => void;
  removeAudio: () => void;
  updateSettings: (patch: Partial<EditSettings>, regenerate?: boolean) => void;
  setExportSettings: (patch: Partial<ExportSettings>) => void;
  generate: () => void;
  regenerate: () => void;
  commit: (tl: Timeline) => void;
  undo: () => void;
  redo: () => void;
  select: (clipId: string | null) => void;
  setPlayhead: (t: Micros) => void;
  setPlaying: (p: boolean) => void;
  setPps: (pps: number) => void;
  setProjectName: (name: string) => void;

  // timeline edits
  moveClip: (from: number, to: number) => void;
  removeClip: (index: number) => void;
  duplicateClip: (index: number) => void;
  rollCut: (index: number, time: Micros, snap: boolean) => void;
  slipClip: (index: number, srcIn: Micros) => void;
  setTransition: (index: number, tr: Transition) => void;
  setEffect: (index: number, type: EffectType, intensity: number | null) => void;
  setFraming: (index: number, framing: Framing | null) => void;
  /** Clip whose framing is being adjusted in the preview (null = not adjusting). */
  adjustingClipId: string | null;
  /** Song section editor (trim / find chorus) dialog. */
  songEditorOpen: boolean;
  setSongEditorOpen: (open: boolean) => void;
  setAdjusting: (clipId: string | null) => void;
  /** Project-level on/off for effects (auto-edit + manual use). */
  setEffectsEnabled: (types: EffectType[], enabled: boolean) => void;
  replaceMedia: (index: number, mediaId: string) => void;
  snapAll: () => void;
  setFades: (fadeIn: Micros, fadeOut: Micros) => void;

  save: () => Promise<void>;
  open: (id: string) => Promise<void>;
  newProject: () => void;
}

let regenTimer: ReturnType<typeof setTimeout> | null = null;

export const useStudio = create<StudioState>((set, get) => {
  const pushHistory = (tl: Timeline | null) => {
    const { timeline, past } = get();
    if (!tl) return;
    set({
      past: timeline ? [...past, timeline].slice(-HISTORY_LIMIT) : past,
      future: [],
      timeline: tl,
      dirty: true,
    });
  };
  const edit = (fn: (tl: Timeline, grid: Micros[]) => Timeline) => {
    const { timeline, grid } = get();
    if (!timeline) return;
    const next = fn(timeline, grid);
    if (next !== timeline) {
      pushHistory(next);
      set({ editedSinceGenerate: true });
    }
  };
  const recomputeGrid = () => {
    const { settings, audio } = get();
    const analysis = editAnalysisOf(get().analysis, settings);
    if (!analysis || !audio) return [];
    return buildGrid(analysis, settings, analysis.duration).beats;
  };

  return {
    projectId: newId(),
    projectName: "Untitled Project",
    dirty: false,
    lastSavedAt: null,
    audio: null,
    analysis: null,
    analysisState: { state: "idle" },
    media: [],
    importing: 0,
    settings: DEFAULT_SETTINGS,
    exportSettings: { resolution: 720, fps: 30 },
    timeline: null,
    grid: [],
    stats: null,
    past: [],
    future: [],
    editedSinceGenerate: false,
    selectedClipId: null,
    playhead: 0,
    playing: false,
    pps: 60,
    toasts: [],

    toast: (text, kind = "info") => {
      const id = newId();
      set((s) => ({ toasts: [...s.toasts, { id, text, kind }].slice(-4) }));
      setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 3500);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    addFiles: async (list) => {
      const audioFile = list.find((f) => classify(f) === "audio");
      const visuals = list.filter((f) => {
        const k = classify(f);
        return k === "video" || k === "image";
      });
      const rejected = list.filter((f) => !classify(f));
      if (rejected.length) get().toast(`Unsupported file${rejected.length > 1 ? "s" : ""}: ${rejected.map((f) => f.name).join(", ")}`, "error");
      if (audioFile) void get().setAudio(audioFile);
      if (!visuals.length) return;
      const room = MAX_MEDIA - get().media.length;
      if (visuals.length > room) get().toast(`Only ${MAX_MEDIA} media items are supported per project; ${visuals.length - room} skipped.`, "error");
      const take = visuals.slice(0, Math.max(0, room));
      set((s) => ({ importing: s.importing + take.length }));
      const results = await mapLimit(take, 3, async (f) => {
        try {
          const { item, url } = await importVisual(f, classify(f) as "video" | "image");
          registerAsset(item.id, f, url);
          set((s) => ({ media: [...s.media, item], dirty: true }));
          return item;
        } finally {
          set((s) => ({ importing: s.importing - 1 }));
        }
      });
      // Concurrent imports finish out of order — restore the order the files were given in.
      const batchIds = results.map((r) => (r.status === "fulfilled" ? r.value.id : null)).filter((x): x is string => !!x);
      set((s) => {
        const batch = batchIds.map((id) => s.media.find((m) => m.id === id)).filter((m): m is MediaItem => !!m);
        return { media: [...s.media.filter((m) => !batchIds.includes(m.id)), ...batch] };
      });
      const failed = results.map((r, i) => (r.status === "rejected" ? `${take[i].name} (${(r.reason as Error).message})` : null)).filter(Boolean);
      if (failed.length) get().toast(`Couldn't import: ${failed.join("; ")}`, "error");
      const st = get();
      if (st.analysis && st.importing === 0 && st.media.length && batchIds.length) {
        if (!st.timeline || !st.editedSinceGenerate) st.generate();
        else st.toast(`Added ${batchIds.length} item${batchIds.length > 1 ? "s" : ""} — Regenerate Edit to use them`, "info");
      }
    },

    setAudio: async (file) => {
      const prev = get().audio;
      let probed: Awaited<ReturnType<typeof probeAudio>>;
      try {
        probed = await probeAudio(file);
      } catch (e) {
        get().toast(`Couldn't read ${file.name}: ${(e as Error).message}`, "error");
        return;
      }
      if (prev) releaseAsset(prev.id);
      registerAsset(probed.asset.id, file, probed.url);
      set((s) => ({ settings: { ...s.settings, trimStart: 0, trimEnd: 0, audioFadeIn: 0, audioFadeOut: 0 } }));
      set({ audio: probed.asset, analysis: null, timeline: null, past: [], future: [], grid: [], stats: null, analysisState: { state: "running", progress: 0, stage: "Starting" }, dirty: true, playhead: 0 });
      try {
        const { analysis, sampleRate } = await analyzeFile(file, (p) => {
          if (get().audio?.id === probed.asset.id) set({ analysisState: { state: "running", ...p } });
        });
        if (get().audio?.id !== probed.asset.id) return; // replaced meanwhile
        set({ analysis, audio: { ...probed.asset, sampleRate, duration: analysis.duration }, analysisState: { state: "done" } });
        get().toast(`Detected ${analysis.bpm.toFixed(1)} BPM · ${analysis.beats.length} beats · ${analysis.sections.length} energy sections (${analysis.method === "essentia" ? "Essentia.js" : "built-in tracker"})`, "success");
        if (get().media.length && get().importing === 0) get().generate();
        else set({ grid: recomputeGrid() });
      } catch (e) {
        set({ analysisState: { state: "error", error: (e as Error).message } });
        get().toast(`Audio analysis failed: ${(e as Error).message}`, "error");
      }
    },

    removeAudio: () => {
      const a = get().audio;
      if (a) releaseAsset(a.id);
      set((s) => ({ settings: { ...s.settings, trimStart: 0, trimEnd: 0, audioFadeIn: 0, audioFadeOut: 0 } }));
      set({ audio: null, analysis: null, timeline: null, past: [], future: [], grid: [], analysisState: { state: "idle" }, dirty: true, playing: false, playhead: 0 });
    },

    removeMedia: (id) => {
      const { timeline, grid } = get();
      let tl = timeline;
      if (tl) {
        for (let i = tl.clips.length - 1; i >= 0; i--) if (tl.clips[i].mediaId === id) tl = ops.removeClip(tl, i, grid);
      }
      releaseAsset(id);
      set((s) => ({ media: s.media.filter((m) => m.id !== id), dirty: true }));
      if (tl && tl !== timeline) {
        if (tl.clips.length) pushHistory(tl);
        else set({ timeline: null, past: [], future: [] });
      }
    },

    moveMedia: (from, to) => {
      const media = get().media.slice();
      const [m] = media.splice(from, 1);
      media.splice(to, 0, m);
      set({ media, dirty: true });
    },

    updateSettings: (patch, regenerate = true) => {
      set((s) => ({ settings: { ...s.settings, ...patch }, dirty: true }));
      // Render-only settings don't change the edit.
      const renderOnly = Object.keys(patch).every((k) => ["aspect", "keepClipAudio", "clipAudioVolume", "audioFadeIn", "audioFadeOut"].includes(k));
      if (!regenerate || renderOnly) return;
      set({ grid: recomputeGrid() });
      if (regenTimer) clearTimeout(regenTimer);
      regenTimer = setTimeout(() => {
        if (get().timeline || (get().analysis && get().media.length)) get().generate();
      }, 180);
    },

    setExportSettings: (patch) => set((s) => ({ exportSettings: { ...s.exportSettings, ...patch }, dirty: true })),

    generate: () => {
      const { media, settings, audio } = get();
      const analysis = editAnalysisOf(get().analysis, settings);
      if (!analysis || !audio) return get().toast("Add a song first", "error");
      if (!media.length) return get().toast("Add some video clips or images first", "error");
      const res = generateTimeline({ analysis, media, settings, duration: analysis.duration });
      pushHistory(res.timeline);
      set({ grid: res.grid.beats, stats: res.stats, selectedClipId: null, editedSinceGenerate: false });
    },

    regenerate: () => {
      get().updateSettings({ seed: (get().settings.seed % 99999) + 1 }, false);
      get().generate();
    },

    commit: (tl) => {
      pushHistory(tl);
      set({ editedSinceGenerate: true });
    },

    undo: () => {
      const { past, timeline, future } = get();
      if (!past.length) return;
      set({ past: past.slice(0, -1), future: timeline ? [timeline, ...future] : future, timeline: past[past.length - 1], dirty: true });
    },
    redo: () => {
      const { past, timeline, future } = get();
      if (!future.length) return;
      set({ future: future.slice(1), past: timeline ? [...past, timeline] : past, timeline: future[0], dirty: true });
    },

    select: (clipId) => set((s) => ({ selectedClipId: clipId, adjustingClipId: s.adjustingClipId && s.adjustingClipId === clipId ? s.adjustingClipId : null })),
    setPlayhead: (t) => {
      const s = get();
      const max = s.timeline?.duration ?? (s.audio ? (s.settings.trimEnd || s.audio.duration) - s.settings.trimStart : 0);
      set({ playhead: Math.max(0, Math.min(t, max)) });
    },
    setPlaying: (p) => set({ playing: p }),
    setPps: (pps) => set({ pps: Math.max(4, Math.min(600, pps)) }),
    setProjectName: (name) => set({ projectName: name || "Untitled Project", dirty: true }),

    moveClip: (from, to) => edit((tl, grid) => ops.moveClip(tl, from, to, grid)),
    removeClip: (index) => {
      edit((tl, grid) => ops.removeClip(tl, index, grid));
      set({ selectedClipId: null });
    },
    duplicateClip: (index) => edit((tl, grid) => ops.duplicateClip(tl, index, grid)),
    rollCut: (index, time, snap) =>
      edit((tl, grid) => ops.rollCut(tl, index, snap ? ops.nearestGridTime(time, grid) : time, grid)),
    slipClip: (index, srcIn) =>
      edit((tl) => {
        const c = tl.clips[index];
        return ops.slipClip(tl, index, srcIn, get().media.find((m) => m.id === c?.mediaId));
      }),
    setTransition: (index, tr) => edit((tl) => ops.setTransition(tl, index, tr)),
    setEffect: (index, type, intensity) => {
      if (intensity !== null && get().settings.disabledEffects.includes(type)) return;
      edit((tl) => ops.setEffect(tl, index, type, intensity));
    },
    setFraming: (index, framing) => edit((tl) => ops.setFraming(tl, index, framing)),
    adjustingClipId: null,
    songEditorOpen: false,
    setSongEditorOpen: (open) => {
      if (open && get().playing) set({ playing: false });
      set({ songEditorOpen: open });
    },
    setAdjusting: (clipId) => set({ adjustingClipId: clipId }),
    setEffectsEnabled: (types, enabled) => {
      const current = new Set(get().settings.disabledEffects);
      for (const t of types) if (enabled) current.delete(t); else current.add(t);
      const disabledEffects = [...current];
      const { timeline, editedSinceGenerate } = get();
      if (!timeline || !editedSinceGenerate) {
        // Untouched auto-edit: regenerate with the same seed so the edit reflects the new set.
        get().updateSettings({ disabledEffects });
        return;
      }
      // Hand-edited timeline: keep the user's edits, only strip what was switched off.
      set((s) => ({ settings: { ...s.settings, disabledEffects }, dirty: true }));
      if (!enabled) {
        const stripped = ops.stripEffects(timeline, types);
        if (stripped !== timeline) pushHistory(stripped);
      } else {
        get().toast("Effect turned on — click Regenerate Edit to let the auto-editor use it", "info");
      }
    },
    replaceMedia: (index, mediaId) => edit((tl) => ops.replaceMedia(tl, index, mediaId)),
    snapAll: () => edit((tl, grid) => ops.snapAllCuts(tl, grid)),
    setFades: (fadeIn, fadeOut) => edit((tl) => ({ ...tl, fadeIn, fadeOut })),

    save: async () => {
      const s = get();
      const doc: ProjectDoc = {
        id: s.projectId, name: s.projectName, createdAt: Date.now(), updatedAt: Date.now(),
        audio: s.audio, analysis: s.analysis, media: s.media, settings: s.settings, timeline: s.timeline,
        exportSettings: s.exportSettings,
      };
      try {
        await saveProject(doc, files);
        set({ dirty: false, lastSavedAt: Date.now() });
        get().toast("Project saved to this browser", "success");
      } catch (e) {
        get().toast(`Save failed: ${(e as Error).message}`, "error");
      }
    },

    open: async (id) => {
      const res = await loadProject(id);
      if (!res) return get().toast("Project not found", "error");
      for (const k of [...urls.keys()]) releaseAsset(k);
      for (const [aid, blob] of res.blobs) registerAsset(aid, blob);
      const { doc } = res;
      const settings = { ...DEFAULT_SETTINGS, ...doc.settings };
      set({
        projectId: doc.id, projectName: doc.name, audio: doc.audio, analysis: doc.analysis, media: doc.media.filter((m) => res.blobs.has(m.id)),
        settings, timeline: doc.timeline, past: [], future: [], editedSinceGenerate: true, selectedClipId: null, playhead: 0, playing: false,
        analysisState: doc.analysis ? { state: "done" } : { state: "idle" }, dirty: false, lastSavedAt: doc.updatedAt,
        exportSettings: (doc.exportSettings as ExportSettings) ?? { resolution: 720, fps: 30 },
        grid: (() => {
          const ea = editAnalysisOf(doc.analysis, settings);
          return ea ? buildGrid(ea, settings, ea.duration).beats : [];
        })(),
      });
      get().toast(`Opened “${doc.name}”`, "success");
    },

    newProject: () => {
      for (const k of [...urls.keys()]) releaseAsset(k);
      set({
        projectId: newId(), projectName: "Untitled Project", audio: null, analysis: null, analysisState: { state: "idle" }, media: [],
        settings: DEFAULT_SETTINGS, timeline: null, grid: [], stats: null, past: [], future: [], selectedClipId: null, playhead: 0, playing: false, dirty: false, lastSavedAt: null,
      });
    },
  };
});

export const selectedIndex = (s: StudioState) =>
  s.timeline && s.selectedClipId ? s.timeline.clips.findIndex((c) => c.id === s.selectedClipId) : -1;
