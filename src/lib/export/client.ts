/** Browser side of the export pipeline: upload assets once, start a render job, poll real progress. */
import type { RenderRequest, RenderStatus } from "../types";

export async function workerHealth(): Promise<{ ffmpeg: string | null; libx264: boolean; aac: boolean } | null> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function putWithProgress(url: string, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed — is the local server running?"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/** Copies every asset the render needs to the local render worker (skipping ones it already has). */
export async function uploadAssets(
  assets: { id: string; blob: Blob; name: string }[],
  onProgress: (fraction: number, label: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const missing: typeof assets = [];
  for (const a of assets) {
    const r = await fetch(`/api/media/${a.id}`, { method: "HEAD", signal });
    const size = Number(r.headers.get("x-size") ?? -1);
    if (!r.ok || size !== a.blob.size) missing.push(a);
  }
  const total = missing.reduce((s, a) => s + a.blob.size, 0) || 1;
  let done = 0;
  for (const a of missing) {
    await putWithProgress(`/api/media/${a.id}`, a.blob, (loaded) => onProgress((done + loaded) / total, `Uploading ${a.name}`), signal);
    done += a.blob.size;
  }
  onProgress(1, "Assets ready");
}

export async function startRender(req: RenderRequest): Promise<RenderStatus> {
  const r = await fetch("/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `Render failed to start (${r.status})`);
  return j;
}

export async function renderStatus(id: string): Promise<RenderStatus> {
  const r = await fetch(`/api/render/${id}`, { cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Lost track of the render job");
  return j;
}

export async function cancelRender(id: string): Promise<void> {
  await fetch(`/api/render/${id}`, { method: "DELETE" });
}
