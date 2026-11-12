/**
 * Local FFmpeg render worker. Runs inside the Next.js Node.js server process.
 *
 * Jobs live in memory (single-user local app). Progress is computed from the
 * frame counters FFmpeg reports via `-progress`, weighted by how many frames
 * each stage encodes — nothing is simulated.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { RenderRequest, RenderStatus } from "@/lib/types";
import { planRender, type RenderPlan } from "@/lib/export/plan";

export const DATA_DIR = process.env.BEATSYNC_DATA_DIR ?? path.join(process.cwd(), ".beatsync-data");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

export const isSafeId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
export const mediaPath = (id: string) => path.join(MEDIA_DIR, id);

interface Job {
  status: RenderStatus;
  dir: string;
  output: string;
  procs: Set<ChildProcess>;
  cancelled: boolean;
  log: string[];
}

const g = globalThis as unknown as { __beatsyncJobs?: Map<string, Job> };
const jobs: Map<string, Job> = (g.__beatsyncJobs ??= new Map());

// Don't leave FFmpeg running when the server stops (e.g. the Mac app quits mid-export).
const gp = globalThis as unknown as { __beatsyncExitHook?: boolean };
if (!gp.__beatsyncExitHook) {
  gp.__beatsyncExitHook = true;
  const killAll = () => {
    for (const job of jobs.values()) for (const p of job.procs) p.kill("SIGKILL");
  };
  process.on("exit", killAll);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      killAll();
      process.exit(0);
    });
  }
}

export function getJob(id: string) {
  return jobs.get(id);
}

export async function startRender(req: RenderRequest): Promise<RenderStatus> {
  validateRequest(req);
  const ids = new Set([...req.timeline.clips.map((c) => c.mediaId), req.audioId]);
  for (const id of ids) {
    try {
      const now = new Date();
      await fs.utimes(mediaPath(id), now, now); // mark as recently used for cache expiry
    } catch {
      throw new Error(`Media ${id} has not been uploaded to the render worker`);
    }
  }
  const plan = planRender(req); // throws on invalid timelines before we queue anything
  await cleanupOldJobs(ids);
  const id = randomUUID();
  const dir = path.join(JOBS_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  const job: Job = {
    status: { id, state: "queued", progress: 0, stage: "Queued", startedAt: Date.now() },
    dir,
    output: path.join(dir, "beatsync-export.mp4"),
    procs: new Set(),
    cancelled: false,
    log: [],
  };
  jobs.set(id, job);
  runJob(job, req, plan).catch((err: unknown) => {
    if (job.cancelled) return;
    job.status = { ...job.status, state: "error", error: errorMessage(err, job), finishedAt: Date.now() };
  });
  return job.status;
}

export function cancelRender(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status.state === "done" || job.status.state === "error") return false;
  job.cancelled = true;
  for (const p of job.procs) p.kill("SIGKILL");
  job.status = { ...job.status, state: "cancelled", stage: "Cancelled", finishedAt: Date.now() };
  fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  return true;
}

function validateRequest(req: RenderRequest) {
  if (!req?.timeline?.clips?.length) throw new Error("Timeline is empty");
  if (![720, 1080].includes(req.export?.resolution)) throw new Error("Resolution must be 720 or 1080");
  if (![24, 30, 60].includes(req.export?.fps)) throw new Error("Frame rate must be 24, 30 or 60");
  if (!["16:9", "9:16", "1:1"].includes(req.aspect)) throw new Error("Unsupported aspect ratio");
  if (!isSafeId(req.audioId)) throw new Error("Invalid audio id");
  for (const c of req.timeline.clips) if (!isSafeId(c.mediaId)) throw new Error("Invalid media id");
}

async function runJob(job: Job, req: RenderRequest, plan: RenderPlan) {
  const set = (patch: Partial<RenderStatus>) => {
    if (!job.cancelled) job.status = { ...job.status, ...patch };
  };
  set({ state: "rendering", stage: "Rendering clips" });

  // Work units = frames encoded by FFmpeg. Pieces tile the output exactly; the
  // final stream-copy mux and optional clip-audio pass are weighted at 5% each.
  const muxWeight = 0.05;
  const total = plan.totalFrames * (1 + muxWeight + (req.keepClipAudio ? 0.05 : 0));
  const doneByPiece = new Array(plan.pieces.length).fill(0);
  let muxDone = 0;
  let audioDone = 0;
  const report = () =>
    set({ progress: Math.min(0.999, (doneByPiece.reduce((a, b) => a + b, 0) + muxDone + audioDone) / total) });

  const mediaById = new Map(req.media.map((m) => [m.id, m]));
  const preset = process.env.BEATSYNC_X264_PRESET ?? "veryfast";
  const piecePath = (i: number) => path.join(job.dir, `p${String(i).padStart(5, "0")}.ts`);

  // ---- 1. pieces, rendered straight from the sources at final quality
  const concurrency = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 3)));
  let next = 0;
  let completed = 0;
  const worker = async () => {
    while (next < plan.pieces.length && !job.cancelled) {
      const piece = plan.pieces[next++];
      const inputs: string[] = [];
      for (const inp of piece.inputs) {
        const m = mediaById.get(inp.mediaId)!;
        if (inp.kind === "image") inputs.push("-loop", "1", "-framerate", String(plan.fps), "-i", mediaPath(inp.mediaId));
        else
          inputs.push(
            "-ss", clampSrc(inp.srcStart, m.duration / 1e6, plan.fps).toFixed(6),
            "-t", Math.max(2 / plan.fps, inp.srcDuration ?? 0).toFixed(6),
            "-i", mediaPath(inp.mediaId),
          );
      }
      await ffmpeg(
        job,
        [
          ...inputs,
          "-filter_complex", piece.filter,
          "-map", "[v]",
          "-frames:v", String(piece.frameCount),
          "-an",
          "-c:v", "libx264", "-preset", preset, "-crf", "19", "-pix_fmt", "yuv420p",
          "-profile:v", "high", "-r", String(plan.fps), "-g", String(plan.fps * 2),
          "-f", "mpegts", piecePath(piece.index),
        ],
        (frame) => { doneByPiece[piece.index] = Math.min(frame, piece.frameCount); report(); },
      );
      doneByPiece[piece.index] = piece.frameCount;
      completed++;
      set({ stage: `Rendering clips & transitions (${completed}/${plan.pieces.length})` });
      report();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (job.cancelled) return;

  // ---- 2. optional clip audio track (sample-exact per clip)
  let clipAudio: string | null = null;
  if (req.keepClipAudio) {
    set({ stage: "Preparing clip audio" });
    clipAudio = await buildClipAudio(job, plan, mediaById, (f) => { audioDone = f * 0.05; report(); });
    if (job.cancelled) return;
  }

  // ---- 3. lossless join (concat demuxer, stream copy) + audio mux
  set({ stage: "Muxing video and music" });
  const listFile = path.join(job.dir, "pieces.txt");
  await fs.writeFile(listFile, plan.pieces.map((p) => `file '${piecePath(p.index)}'`).join("\n"));
  const total_s = plan.totalSeconds.toFixed(6);
  const inputs = ["-f", "concat", "-safe", "0", "-i", listFile, "-i", mediaPath(req.audioId)];
  // Music: the chosen section of the song, padded/trimmed to the exact video length, with optional fades.
  const aStart = Math.max(0, (req.audioStart ?? 0) / 1e6);
  const fades: string[] = [];
  const fin = Math.min((req.audioFadeIn ?? 0) / 1e6, plan.totalSeconds);
  const fout = Math.min((req.audioFadeOut ?? 0) / 1e6, plan.totalSeconds);
  if (fin > 0) fades.push(`afade=t=in:st=0:d=${fin.toFixed(4)}`);
  if (fout > 0) fades.push(`afade=t=out:st=${(plan.totalSeconds - fout).toFixed(4)}:d=${fout.toFixed(4)}`);
  let audioFilter =
    `[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=start=${aStart.toFixed(6)},asetpts=PTS-STARTPTS,` +
    `apad,atrim=end=${total_s},asetpts=N/SR/TB${fades.length ? "," + fades.join(",") : ""}[am]`;
  if (clipAudio) {
    inputs.push("-i", clipAudio);
    audioFilter += `;[2:a]aformat=channel_layouts=stereo,volume=${req.clipAudioVolume.toFixed(3)}[ac];[am][ac]amix=inputs=2:duration=first:normalize=0[aout]`;
  } else {
    audioFilter = audioFilter.replace("[am]", "[aout]");
  }
  await ffmpeg(
    job,
    [
      ...inputs,
      "-filter_complex", audioFilter,
      "-map", "0:v", "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", total_s,
      "-movflags", "+faststart",
      job.output,
    ],
    (frame) => { muxDone = Math.min(frame, plan.totalFrames) * muxWeight; report(); },
  );
  if (job.cancelled) return;

  // Remove intermediates, keep the export.
  const files = await fs.readdir(job.dir);
  await Promise.all(files.filter((f) => f !== path.basename(job.output)).map((f) => fs.rm(path.join(job.dir, f), { force: true })));
  const st = await fs.stat(job.output);
  set({ state: "done", progress: 1, stage: "Done", finishedAt: Date.now(), outputBytes: st.size });
}

/** Keep -ss inside the media so FFmpeg always decodes at least one frame. */
function clampSrc(srcStart: number, mediaDur: number, fps: number) {
  const s = Math.max(0, srcStart);
  return mediaDur > 0 ? Math.min(s, Math.max(0, mediaDur - 2 / fps)) : s;
}

async function buildClipAudio(
  job: Job,
  plan: RenderPlan,
  mediaById: Map<string, RenderRequest["media"][number]>,
  onFrames: (frames: number) => void,
): Promise<string> {
  const SR = 48000;
  const list: string[] = [];
  let frames = 0;
  for (const seg of plan.clips) {
    if (job.cancelled) break;
    const samples = (seg.frameCount * SR) / plan.fps; // integer for 24/30/60 fps
    const out = path.join(job.dir, `aud${String(seg.index).padStart(4, "0")}.wav`);
    const m = mediaById.get(seg.mediaId)!;
    // Time-remapped clips (slow-mo, boomerang, …) contribute silence rather than out-of-sync audio.
    const hasAudio = m.kind === "video" && !seg.remapped && (await probeHasAudio(mediaPath(seg.mediaId)));
    const input = hasAudio
      ? ["-ss", Math.max(0, seg.srcStart).toFixed(6), "-i", mediaPath(seg.mediaId), "-vn"]
      : ["-f", "lavfi", "-i", `anullsrc=r=${SR}:cl=stereo`];
    await ffmpeg(job, [
      ...input,
      "-af", `aresample=${SR},aformat=channel_layouts=stereo,apad,atrim=end_sample=${samples}`,
      "-ar", String(SR), "-ac", "2", "-c:a", "pcm_s16le", out,
    ]);
    list.push(`file '${out.replace(/'/g, "'\\''")}'`);
    frames += seg.frameCount;
    onFrames(frames);
  }
  const listFile = path.join(job.dir, "clipaudio.txt");
  await fs.writeFile(listFile, list.join("\n"));
  const out = path.join(job.dir, "clipaudio.wav");
  await ffmpeg(job, ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out]);
  return out;
}

const audioProbeCache = new Map<string, boolean>();
export async function probeHasAudio(file: string): Promise<boolean> {
  if (audioProbeCache.has(file)) return audioProbeCache.get(file)!;
  const out = await new Promise<string>((resolve) => {
    const p = spawn(/*turbopackIgnore: true*/ FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
    let s = "";
    p.stdout.on("data", (d) => (s += d));
    p.on("close", () => resolve(s));
    p.on("error", () => resolve(""));
  });
  const has = out.trim().length > 0;
  audioProbeCache.set(file, has);
  return has;
}

function ffmpeg(job: Job, args: string[], onFrame?: (frame: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error("cancelled"));
    const full = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", ...args];
    const p = spawn(/*turbopackIgnore: true*/ FFMPEG, full, { stdio: ["ignore", "pipe", "pipe"] });
    job.procs.add(p);
    let err = "";
    let buf = "";
    p.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (onFrame && line.startsWith("frame=")) onFrame(parseInt(line.slice(6), 10) || 0);
      }
    });
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    p.on("error", (e) => { job.procs.delete(p); reject(e); });
    p.on("close", (code) => {
      job.procs.delete(p);
      if (job.cancelled) return reject(new Error("cancelled"));
      if (code === 0) return resolve();
      job.log.push(err);
      reject(new Error(`FFmpeg exited with code ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

function errorMessage(err: unknown, job: Job) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT/.test(msg) && /spawn/.test(msg)) return "FFmpeg was not found. Install it (e.g. `brew install ffmpeg`) or set FFMPEG_PATH.";
  void job;
  return msg;
}

async function cleanupOldJobs(keep: Set<string>) {
  // Uploaded media is a cache: the client re-uploads anything missing, so stale copies can go.
  const mediaCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const f of await fs.readdir(MEDIA_DIR).catch(() => [] as string[])) {
    if (keep.has(f)) continue;
    const p = path.join(MEDIA_DIR, f);
    const st = await fs.stat(p).catch(() => null);
    if (st && st.mtimeMs < mediaCutoff) await fs.rm(p, { force: true }).catch(() => {});
  }
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if ((job.status.finishedAt ?? Date.now()) < cutoff) {
      jobs.delete(id);
      await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Stream an upload body to disk atomically. */
export async function saveUpload(id: string, body: ReadableStream<Uint8Array>): Promise<number> {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const tmp = mediaPath(id) + ".part";
  const ws = createWriteStream(tmp);
  let bytes = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (!ws.write(value)) await new Promise<void>((r) => ws.once("drain", () => r()));
    }
    await new Promise<void>((res, rej) => ws.end((e?: Error | null) => (e ? rej(e) : res())));
    await fs.rename(tmp, mediaPath(id));
    return bytes;
  } catch (e) {
    ws.destroy();
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
