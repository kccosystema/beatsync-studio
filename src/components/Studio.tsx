"use client";
import { useEffect, useState } from "react";
import { selectedIndex, useStudio } from "@/store/studio";
import LeftPanel, { MediaTab } from "./LeftPanel";
import RightPanel, { EditSettingsPanel } from "./RightPanel";
import PreviewPanel from "./PreviewPanel";
import Timeline from "./Timeline";
import ExportDialog from "./ExportDialog";
import ProjectsDialog from "./ProjectsDialog";
import SongEditor from "./SongEditor";
import { Button, Icon, IconButton } from "./ui";
import { transport } from "./transport";

export default function Studio() {
  const [exportOpen, setExportOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [mobileTab, setMobileTab] = useState<"media" | "edit" | "timeline">("media");
  const addFiles = useStudio((s) => s.addFiles);
  const isDesktop = useIsDesktop();
  const songEditorOpen = useStudio((s) => s.songEditorOpen);

  // Dev-only handle for automated browser testing.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") (window as unknown as { __beatsync?: typeof useStudio }).__beatsync = useStudio;
  }, []);

  // window-wide drag & drop of files
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => { if (!isFiles(e)) return; depth++; setDropping(true); };
    const leave = (e: DragEvent) => { if (!isFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDropping(false); };
    const over = (e: DragEvent) => { if (isFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void addFiles(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [addFiles]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      const s = useStudio.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === "Space") { e.preventDefault(); if (s.audio) transport.toggle(); }
      else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) s.redo(); else s.undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); s.redo(); }
      else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void s.save(); }
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); const i = selectedIndex(s); if (i >= 0) s.duplicateClip(i); }
      else if (e.key === "Delete" || e.key === "Backspace") { const i = selectedIndex(s); if (i >= 0) { e.preventDefault(); s.removeClip(i); } }
      else if (e.key === "Home") transport.seek(0);
      else if (e.key === "Escape") {
        if (s.adjustingClipId) s.setAdjusting(null);
        else s.select(null);
      }
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const now = transport.time();
        const g = s.grid;
        if (!g.length) return transport.seek(now + (e.key === "ArrowLeft" ? -1e6 : 1e6) / 10);
        const next = e.key === "ArrowRight" ? g.find((b) => b > now + 1000) : [...g].reverse().find((b) => b < now - 1000);
        transport.seek(next ?? (e.key === "ArrowRight" ? s.timeline?.duration ?? now : 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // warn before leaving with unsaved work
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (useStudio.getState().dirty && useStudio.getState().media.length) e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-ink-950 text-ink-100">
      <TopBar onExport={() => setExportOpen(true)} onProjects={() => setProjectsOpen(true)} />

      {/* Desktop workspace */}
      {isDesktop === true && (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <aside className="w-72 shrink-0 border-r border-ink-800 bg-ink-900 xl:w-80"><LeftPanel /></aside>
          <main className="flex min-w-0 flex-1 flex-col"><PreviewPanel /></main>
          <aside className="w-72 shrink-0 border-l border-ink-800 bg-ink-900 xl:w-80"><RightPanel /></aside>
        </div>
        <div className="h-[200px] shrink-0 border-t border-ink-800"><Timeline /></div>
      </div>
      )}

      {/* Mobile / tablet simplified workspace */}
      {isDesktop === false && (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="h-[38vh] shrink-0 flex flex-col"><PreviewPanel /></div>
        <div className="flex border-y border-ink-800 bg-ink-900">
          {(["media", "edit", "timeline"] as const).map((t) => (
            <button key={t} onClick={() => setMobileTab(t)} className={`flex-1 py-2 text-xs font-medium capitalize ${mobileTab === t ? "text-white shadow-[inset_0_-2px_0_#8b5cf6]" : "text-ink-400"}`}>{t}</button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-ink-900">
          {mobileTab === "media" && <div className="p-3"><MediaTab /></div>}
          {mobileTab === "edit" && <div className="p-3"><EditSettingsPanel /></div>}
          {mobileTab === "timeline" && <div className="h-[200px]"><Timeline compact /></div>}
        </div>
      </div>
      )}

      {dropping && (
        <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-violet/10 backdrop-blur-[2px]">
          <div className="animate-pop rounded-2xl border-2 border-dashed border-violet bg-ink-900/90 px-10 py-8 text-center">
            <Icon name="upload" size={32} className="mx-auto mb-2 text-violet-soft" />
            <div className="text-lg font-semibold text-white">Drop to import</div>
            <div className="text-xs text-ink-300">Songs, video clips and photos</div>
          </div>
        </div>
      )}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {projectsOpen && <ProjectsDialog onClose={() => setProjectsOpen(false)} />}
      {songEditorOpen && <SongEditor onClose={() => useStudio.getState().setSongEditorOpen(false)} />}
      <Toasts />
    </div>
  );
}

function useIsDesktop(): boolean | null {
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setV(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return v;
}

function TopBar({ onExport, onProjects }: { onExport: () => void; onProjects: () => void }) {
  const name = useStudio((s) => s.projectName);
  const setName = useStudio((s) => s.setProjectName);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const save = useStudio((s) => s.save);
  const dirty = useStudio((s) => s.dirty);
  const hasTimeline = useStudio((s) => !!s.timeline?.clips.length);
  const [saving, setSaving] = useState(false);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-800 bg-ink-900 px-3">
      <div className="flex items-center gap-2 pr-2">
        <Logo />
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">
          BeatSync <span className="bs-grad-text">Studio</span>
        </span>
      </div>
      <div className="mx-1 hidden h-5 w-px bg-ink-700 sm:block" />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-32 min-w-0 rounded-md bg-transparent px-2 py-1 text-sm text-ink-100 outline-none hover:bg-ink-800 focus:bg-ink-800 sm:w-56"
        aria-label="Project name"
        data-testid="project-name"
      />
      {dirty && <span className="hidden h-1.5 w-1.5 rounded-full bg-amber-400 sm:block" title="Unsaved changes" />}
      <div className="flex-1" />
      <IconButton icon="undo" label="Undo (⌘Z)" onClick={undo} disabled={!canUndo} data-testid="undo" />
      <IconButton icon="redo" label="Redo (⇧⌘Z)" onClick={redo} disabled={!canRedo} data-testid="redo" />
      <div className="mx-1 h-5 w-px bg-ink-700" />
      <Button variant="ghost" size="sm" onClick={onProjects} data-testid="projects-btn"><Icon name="folder" size={14} /><span className="hidden sm:inline">Projects</span></Button>
      <Button
        variant="ghost" size="sm" data-testid="save-btn" disabled={saving}
        onClick={async () => { setSaving(true); await save(); setSaving(false); }}
      >
        <Icon name="save" size={14} /><span className="hidden sm:inline">{saving ? "Saving…" : "Save"}</span>
      </Button>
      <Button variant="primary" size="sm" onClick={onExport} disabled={!hasTimeline} data-testid="export-btn"><Icon name="export" size={14} /> Export</Button>
    </header>
  );
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="bsg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#bsg)" />
      {[6, 10, 14, 18, 22, 26].map((x, i) => (
        <rect key={x} x={x - 1} y={16 - [4, 8, 11, 7, 10, 5][i]} width="2" height={[4, 8, 11, 7, 10, 5][i] * 2} rx="1" fill="white" opacity={i % 2 ? 0.75 : 1} />
      ))}
    </svg>
  );
}

function Toasts() {
  const toasts = useStudio((s) => s.toasts);
  const dismiss = useStudio((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" data-testid="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex animate-fade items-start gap-2 rounded-xl border px-3 py-2.5 text-xs shadow-xl ${t.kind === "error" ? "border-red-500/40 bg-[#2a1215] text-red-100" : t.kind === "success" ? "border-emerald-500/40 bg-[#0f2219] text-emerald-100" : "border-ink-600 bg-ink-800 text-ink-100"}`}
        >
          <Icon name={t.kind === "error" ? "alert" : "check"} size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="text-ink-400 hover:text-white" aria-label="Dismiss"><Icon name="x" size={12} /></button>
        </div>
      ))}
    </div>
  );
}
