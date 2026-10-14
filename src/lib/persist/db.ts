/**
 * Project persistence in IndexedDB. Project documents and media blobs live in
 * separate stores; blobs are written once per asset id and never to localStorage.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AudioAsset, BeatAnalysis, EditSettings, MediaItem, Timeline } from "../types";

export interface ProjectDoc {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  audio: AudioAsset | null;
  analysis: BeatAnalysis | null;
  media: MediaItem[];
  settings: EditSettings;
  timeline: Timeline | null;
  exportSettings?: { resolution: number; fps: number };
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  clips: number;
  media: number;
  audioName?: string;
  thumbnail?: string;
}

interface Schema extends DBSchema {
  projects: { key: string; value: ProjectDoc };
  blobs: { key: string; value: { id: string; blob: Blob; projectIds: string[] } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
const db = () =>
  (dbp ??= openDB<Schema>("beatsync-studio", 1, {
    upgrade(d) {
      d.createObjectStore("projects", { keyPath: "id" });
      d.createObjectStore("blobs", { keyPath: "id" });
    },
  }));

export async function saveProject(doc: ProjectDoc, blobs: Map<string, Blob>): Promise<void> {
  const d = await db();
  const needed = [doc.audio?.id, ...doc.media.map((m) => m.id)].filter(Boolean) as string[];
  // Write blobs in their own transactions first (large writes), then the doc.
  for (const id of needed) {
    const existing = await d.get("blobs", id);
    if (existing) {
      if (!existing.projectIds.includes(doc.id)) await d.put("blobs", { ...existing, projectIds: [...existing.projectIds, doc.id] });
      continue;
    }
    const blob = blobs.get(id);
    if (!blob) throw new Error(`Missing file data for ${id}`);
    await d.put("blobs", { id, blob, projectIds: [doc.id] });
  }
  await d.put("projects", { ...doc, updatedAt: Date.now() });
}

export async function loadProject(id: string): Promise<{ doc: ProjectDoc; blobs: Map<string, Blob> } | null> {
  const d = await db();
  const doc = await d.get("projects", id);
  if (!doc) return null;
  const blobs = new Map<string, Blob>();
  for (const aid of [doc.audio?.id, ...doc.media.map((m) => m.id)].filter(Boolean) as string[]) {
    const b = await d.get("blobs", aid);
    if (b) blobs.set(aid, b.blob);
  }
  return { doc, blobs };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const d = await db();
  const all = await d.getAll("projects");
  return all
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => ({
      id: p.id, name: p.name, updatedAt: p.updatedAt, clips: p.timeline?.clips.length ?? 0,
      media: p.media.length, audioName: p.audio?.name, thumbnail: p.media[0]?.thumbnail,
    }));
}

export async function deleteProject(id: string): Promise<void> {
  const d = await db();
  const doc = await d.get("projects", id);
  if (!doc) return;
  for (const aid of [doc.audio?.id, ...doc.media.map((m) => m.id)].filter(Boolean) as string[]) {
    const b = await d.get("blobs", aid);
    if (!b) continue;
    const rest = b.projectIds.filter((p) => p !== id);
    if (rest.length) await d.put("blobs", { ...b, projectIds: rest });
    else await d.delete("blobs", aid);
  }
  await d.delete("projects", id);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}
