"use client";
import { useEffect, useState } from "react";
import { deleteProject, listProjects, storageEstimate, type ProjectSummary } from "@/lib/persist/db";
import { useStudio } from "@/store/studio";
import { Button, Icon, IconButton, formatBytes } from "./ui";

export default function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const open = useStudio((s) => s.open);
  const newProject = useStudio((s) => s.newProject);
  const dirty = useStudio((s) => s.dirty);
  const refresh = () => {
    listProjects().then(setList).catch(() => setList([]));
    storageEstimate().then(setUsage);
  };
  useEffect(refresh, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const confirmLeave = () => !dirty || confirm("You have unsaved changes. Continue without saving?");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg animate-pop flex-col rounded-2xl border border-ink-700 bg-ink-900 p-5" onClick={(e) => e.stopPropagation()} data-testid="projects-dialog">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Projects</h2>
            <p className="text-[11px] text-ink-400">Stored in this browser (IndexedDB){usage ? ` · ${formatBytes(usage.usage)} used` : ""}</p>
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <Button className="mb-3" onClick={() => { if (confirmLeave()) { newProject(); onClose(); } }}><Icon name="plus" /> New project</Button>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {list === null && <div className="text-xs text-ink-400">Loading…</div>}
          {list?.length === 0 && <div className="rounded-lg bg-ink-850 p-4 text-center text-xs text-ink-400">No saved projects yet. Use Save in the top bar.</div>}
          {list?.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 p-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.thumbnail ? <img src={p.thumbnail} alt="" className="h-10 w-16 rounded object-cover" /> : <div className="h-10 w-16 rounded bg-ink-750" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white">{p.name}</div>
                <div className="truncate text-[11px] text-ink-400">{new Date(p.updatedAt).toLocaleString()} · {p.media} media · {p.clips} clips{p.audioName ? ` · ${p.audioName}` : ""}</div>
              </div>
              <Button size="sm" variant="primary" onClick={async () => { if (confirmLeave()) { await open(p.id); onClose(); } }}>Open</Button>
              <IconButton icon="trash" label={`Delete ${p.name}`} onClick={async () => { if (confirm(`Delete “${p.name}”? This removes its stored media too.`)) { await deleteProject(p.id); refresh(); } }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
