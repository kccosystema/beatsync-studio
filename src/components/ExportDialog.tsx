"use client";
import { useEffect, useRef, useState } from "react";
import { assetBlob, useStudio } from "@/store/studio";
import { cancelRender, renderStatus, startRender, uploadAssets, workerHealth } from "@/lib/export/client";
import { exportLabel, planRender } from "@/lib/export/plan";
import { validateTimeline } from "@/lib/timeline/ops";
import type { ExportFps, ExportResolution, RenderStatus } from "@/lib/types";
import { Button, Icon, IconButton, ProgressBar, Segmented, formatBytes } from "./ui";

type Phase = { kind: "idle" } | { kind: "uploading"; progress: number; label: string } | { kind: "rendering"; status: RenderStatus; elapsed: number } | { kind: "done"; status: RenderStatus } | { kind: "error"; error: string } | { kind: "cancelled" };

export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const st = useStudio();
  const { timeline, media, audio, settings, exportSettings, projectName } = st;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [health, setHealth] = useState<Awaited<ReturnType<typeof workerHealth>> | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);

  useEffect(() => {
    workerHealth().then(setHealth);
  }, []);

  const busyNow = phase.kind === "uploading" || phase.kind === "rendering";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busyNow) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busyNow]);

  useEffect(() => {
    if (phase.kind !== "rendering") return;
    const id = phase.status.id;
    let stop = false;
    const tick = async () => {
      try {
        const s = await renderStatus(id);
        if (stop) return;
        if (s.state === "done") setPhase({ kind: "done", status: s });
        else if (s.state === "error") setPhase({ kind: "error", error: s.error ?? "Render failed" });
        else if (s.state === "cancelled") setPhase({ kind: "cancelled" });
        else setPhase({ kind: "rendering", status: s, elapsed: (Date.now() - s.startedAt) / 1000 });
      } catch (e) {
        if (!stop) setPhase({ kind: "error", error: (e as Error).message });
      }
    };
    const t = setInterval(tick, 400);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [phase.kind, phase.kind === "rendering" ? phase.status.id : null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!timeline || !audio) return null;
  const issues = validateTimeline(timeline, media);
  let planInfo = "";
  try {
    const plan = planRender({ timeline, media, aspect: settings.aspect, export: exportSettings });
    planInfo = `${plan.totalFrames.toLocaleString()} frames · ${plan.clips.length} clips · ${plan.transitionFrames.filter(Boolean).length} transitions`;
  } catch (e) {
    planInfo = (e as Error).message;
  }

  const start = async () => {
    abort.current = new AbortController();
    try {
      const used = new Set(timeline.clips.map((c) => c.mediaId));
      const assets = [audio, ...media.filter((m) => used.has(m.id))].map((a) => ({ id: a.id, name: a.name, blob: assetBlob(a.id)! }));
      if (assets.some((a) => !a.blob)) throw new Error("Some media files are no longer available in this tab");
      setPhase({ kind: "uploading", progress: 0, label: "Checking assets" });
      await uploadAssets(assets, (progress, label) => setPhase({ kind: "uploading", progress, label }), abort.current.signal);
      const status = await startRender({
        timeline,
        media: media.filter((m) => used.has(m.id)).map(({ id, kind, duration, width, height, name }) => ({ id, kind, duration, width, height, name })),
        audioId: audio.id,
        audioDuration: audio.duration,
        aspect: settings.aspect,
        export: exportSettings,
        keepClipAudio: settings.keepClipAudio,
        clipAudioVolume: settings.clipAudioVolume,
        audioStart: settings.trimStart,
        audioFadeIn: settings.audioFadeIn,
        audioFadeOut: settings.audioFadeOut,
      });
      jobId.current = status.id;
      setPhase({ kind: "rendering", status, elapsed: 0 });
    } catch (e) {
      if ((e as Error).name === "AbortError") setPhase({ kind: "cancelled" });
      else setPhase({ kind: "error", error: (e as Error).message });
    }
  };

  const cancel = async () => {
    abort.current?.abort();
    if (jobId.current && phase.kind === "rendering") await cancelRender(jobId.current);
    setPhase({ kind: "cancelled" });
  };

  const busy = phase.kind === "uploading" || phase.kind === "rendering";
  const elapsed = phase.kind === "rendering" ? phase.elapsed : 0;
  const eta = phase.kind === "rendering" && phase.status.progress > 0.03 ? elapsed / phase.status.progress - elapsed : null;
  const safeName = projectName.replace(/[^\w.\- ]+/g, "").trim() || "beatsync-export";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-md animate-pop rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()} data-testid="export-dialog">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Export video</h2>
            <p className="text-[11px] text-ink-400">Rendered locally by FFmpeg · MP4 (H.264 + AAC)</p>
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} disabled={busy} />
        </div>

        {health === null && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">The local render worker isn&apos;t reachable. Start the app with <code>npm run dev</code> or <code>npm start</code>.</div>
        )}
        {health && !health.ffmpeg && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">FFmpeg was not found on this machine. Install it (macOS: <code>brew install ffmpeg</code>) or set <code>FFMPEG_PATH</code>, then restart.</div>
        )}

        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-xs text-ink-300">Resolution</div>
            <Segmented<ExportResolution> value={exportSettings.resolution} onChange={(resolution) => st.setExportSettings({ resolution })} options={[{ value: 720, label: "720p" }, { value: 1080, label: "1080p" }]} />
          </div>
          <div>
            <div className="mb-1.5 text-xs text-ink-300">Frame rate</div>
            <Segmented<ExportFps> value={exportSettings.fps} onChange={(fps) => st.setExportSettings({ fps })} options={[{ value: 24, label: "24 fps" }, { value: 30, label: "30 fps" }, { value: 60, label: "60 fps" }]} />
          </div>
          <div className="rounded-lg bg-ink-850 p-3 text-[11px] text-ink-300">
            <div className="text-ink-100">{exportLabel(settings.aspect, exportSettings)} · {settings.aspect}</div>
            <div>{planInfo}</div>
            {settings.keepClipAudio && <div>Original clip audio mixed at {Math.round(settings.clipAudioVolume * 100)}%</div>}
            {issues.length > 0 && <div className="mt-1 text-amber-300">{issues.length} clip{issues.length > 1 ? "s" : ""}: {issues[0].message}</div>}
          </div>
        </div>

        <div className="mt-5" data-testid="export-status">
          {phase.kind === "uploading" && (
            <div className="space-y-1.5">
              <ProgressBar value={phase.progress} />
              <div className="flex justify-between text-[11px] text-ink-300"><span>{phase.label}</span><span>{Math.round(phase.progress * 100)}%</span></div>
            </div>
          )}
          {phase.kind === "rendering" && (
            <div className="space-y-1.5">
              <ProgressBar value={phase.status.progress} />
              <div className="flex justify-between text-[11px] text-ink-300">
                <span>{phase.status.stage}</span>
                <span className="font-mono">{Math.round(phase.status.progress * 100)}%{eta !== null ? ` · ~${Math.ceil(eta)}s left` : ""}</span>
              </div>
            </div>
          )}
          {phase.kind === "done" && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200">
              <div className="flex items-center gap-1.5 font-medium"><Icon name="check" size={14} /> Export complete</div>
              <div className="mt-0.5 text-emerald-200/80">{formatBytes(phase.status.outputBytes ?? 0)} · rendered in {(((phase.status.finishedAt ?? phase.status.startedAt) - phase.status.startedAt) / 1000).toFixed(1)}s</div>
            </div>
          )}
          {phase.kind === "error" && <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200 break-words" data-testid="export-error">{phase.error}</div>}
          {phase.kind === "cancelled" && <div className="text-xs text-ink-400">Export cancelled.</div>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {busy ? (
            <Button variant="danger" onClick={cancel} data-testid="export-cancel">Cancel export</Button>
          ) : phase.kind === "done" ? (
            <>
              <Button onClick={() => setPhase({ kind: "idle" })}>Export again</Button>
              <a href={`/api/render/${phase.status.id}/file?name=${encodeURIComponent(safeName)}`} download={`${safeName}.mp4`} data-testid="export-download">
                <Button variant="primary"><Icon name="export" /> Download MP4</Button>
              </a>
            </>
          ) : (
            <Button variant="primary" onClick={start} disabled={!health?.ffmpeg || !timeline.clips.length} data-testid="export-start">
              <Icon name="bolt" /> Render MP4
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
