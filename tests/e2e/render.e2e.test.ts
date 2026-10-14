/**
 * End-to-end: synthetic song + synthetic clips → analysis → auto-edit →
 * real FFmpeg render → verify the MP4 (codecs, size, duration, and that hard
 * cuts land on the planned beat frames via FFmpeg scene detection).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthTrack } from "../synth";
import { encodeWav } from "../wav";
import { analyzeAudio } from "@/lib/audio/analyze";
import { generateTimeline } from "@/lib/engine/generate";
import { planRender } from "@/lib/export/plan";
import { DEFAULT_SETTINGS, type MediaItem, type RenderRequest, type ExportFps } from "@/lib/types";

const work = mkdtempSync(path.join(os.tmpdir(), "beatsync-e2e-"));
process.env.BEATSYNC_DATA_DIR = path.join(work, "data");

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const probe = (file: string) =>
  JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height,duration,r_frame_rate:format=duration", "-of", "json", file]).toString());

function makeMedia(): { media: MediaItem[]; files: Record<string, string> } {
  const colors = ["red", "lime", "blue", "yellow", "magenta", "cyan"];
  const media: MediaItem[] = [];
  const files: Record<string, string> = {};
  colors.forEach((c, i) => {
    const id = `vid${i}`;
    const file = path.join(work, `${id}.mp4`);
    const portrait = i === 5;
    const size = portrait ? "360x640" : "640x360";
    const args = ["-f", "lavfi", "-i", `color=c=${c}:s=${size}:r=30:d=9,noise=alls=12:allf=t`];
    if (i === 0) args.push("-f", "lavfi", "-i", "sine=f=440:d=9", "-c:a", "aac", "-shortest");
    ff([...args, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    files[id] = file;
    media.push({ id, kind: "video", name: `${c}.mp4`, mime: "video/mp4", size: 1, duration: 9e6, width: portrait ? 360 : 640, height: portrait ? 640 : 360, motion: 0.3 });
  });
  const img = path.join(work, "img.png");
  ff(["-f", "lavfi", "-i", "color=c=white:s=800x600,drawbox=x=100:y=100:w=300:h=300:c=black:t=fill", "-frames:v", "1", img]);
  files.img0 = img;
  media.push({ id: "img0", kind: "image", name: "img.png", mime: "image/png", size: 1, duration: 0, width: 800, height: 600 });
  return { media, files };
}

async function render(req: RenderRequest) {
  const { startRender, getJob } = await import("@/server/render");
  const st = await startRender(req);
  const progress: number[] = [];
  for (let i = 0; i < 1200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const job = getJob(st.id)!;
    progress.push(job.status.progress);
    if (job.status.state === "done") return { job, progress };
    if (job.status.state === "error") throw new Error(job.status.error);
  }
  throw new Error("render timed out");
}

describe("end-to-end export", () => {
  const song = synthTrack({ bpm: 120, seconds: 20, loudFrom: 10, offset: 0.3 });
  const songFile = path.join(work, "song.wav");
  writeFileSync(songFile, encodeWav(song.samples, song.sampleRate));
  const analysis = analyzeAudio(song.samples, song.sampleRate);
  const { media, files } = makeMedia();
  const mediaDir = path.join(process.env.BEATSYNC_DATA_DIR!, "media");
  mkdirSync(mediaDir, { recursive: true });
  for (const [id, f] of Object.entries(files)) copyFileSync(f, path.join(mediaDir, id));
  copyFileSync(songFile, path.join(mediaDir, "song0"));

  for (const fps of [30, 24] as ExportFps[]) {
    it(`renders a beat-synced MP4 at ${fps} fps`, async () => {
      const settings = { ...DEFAULT_SETTINGS, preset: "edm" as const, transitionFrequency: 60, seed: 11 };
      const { timeline } = generateTimeline({ analysis, media, settings });
      const req: RenderRequest = {
        timeline, media, audioId: "song0", audioDuration: analysis.duration, aspect: "16:9",
        export: { resolution: 720, fps }, keepClipAudio: fps === 30, clipAudioVolume: 0.3,
      };
      const plan = planRender(req);
      const { job, progress } = await render(req);
      const out = job.output;

      // progress is real and monotonic
      expect(progress.some((p) => p > 0 && p < 1)).toBe(true);
      for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);

      const info = probe(out);
      const v = info.streams.find((s: any) => s.codec_type === "video");
      const a = info.streams.find((s: any) => s.codec_type === "audio");
      expect(v.codec_name).toBe("h264");
      expect(a.codec_name).toBe("aac");
      expect(v.width).toBe(1280);
      expect(v.height).toBe(720);
      expect(v.r_frame_rate).toBe(`${fps}/1`);
      // exact frame count
      const frames = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out]).toString().trim());
      expect(frames).toBe(plan.totalFrames);
      expect(Math.abs(parseFloat(v.duration) - plan.totalSeconds)).toBeLessThanOrEqual(1 / fps + 1e-3);
      expect(Math.abs(parseFloat(a.duration) - parseFloat(v.duration))).toBeLessThan(0.05);

      // scene detection: every hard cut should be detected within one frame of its beat
      const stderr = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i "${out}" -vf "select='gt(scene,0.2)',showinfo" -an -f null - 2>&1 | grep pts_time || true`]).toString();
      const detected = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => parseFloat(m[1]));
      const hardCuts = plan.cutFrames.slice(1).filter((_, i) => !plan.transitionFrames[i + 1]).map((f) => f / fps);
      expect(hardCuts.length).toBeGreaterThan(5);
      const hits = hardCuts.filter((t) => detected.some((d) => Math.abs(d - t) <= 1 / fps + 1e-3));
      expect(hits.length / hardCuts.length).toBeGreaterThanOrEqual(0.9);

      // and those cut times are on detected musical beats (within a frame)
      const beats = analysis.beats.map((b) => b / 1e6);
      for (const t of hardCuts) expect(beats.some((b) => Math.abs(b - t) <= 0.5 / fps + 1e-6)).toBe(true);
    }, 300_000);
  }

  it("renders 9:16 at 1080p / 60 fps with exact frame count", async () => {
    const short = { ...analysis, duration: 8_000_000, beats: analysis.beats.filter((b) => b < 8_000_000) };
    const { timeline } = generateTimeline({ analysis: short, media, settings: { ...DEFAULT_SETTINGS, preset: "social", transitionFrequency: 70, seed: 5 } });
    const req: RenderRequest = { timeline, media, audioId: "song0", audioDuration: short.duration, aspect: "9:16", export: { resolution: 1080, fps: 60 }, keepClipAudio: false, clipAudioVolume: 0 };
    const plan = planRender(req);
    const { job } = await render(req);
    const info = probe(job.output);
    const v = info.streams.find((s: any) => s.codec_type === "video");
    expect([v.width, v.height, v.r_frame_rate]).toEqual([1080, 1920, "60/1"]);
    const frames = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", job.output]).toString().trim());
    expect(frames).toBe(plan.totalFrames);
    expect(plan.totalFrames).toBe(480);
  }, 300_000);

  it("renders every new effect (time remaps, split, prism, rgb, hue, black fade) frame-exactly", async () => {
    const types = ["slowMo", "speed", "boomerang", "jumpCut", "fastCut", "rgb", "hue", "blackFade", "split", "prism"] as const;
    const { timeline } = generateTimeline({ analysis, media, settings: { ...DEFAULT_SETTINGS, preset: "cinematic", transitionFrequency: 60, seed: 3 } });
    const tl = { ...timeline, clips: timeline.clips.map((c, i) => ({ ...c, effects: [{ type: types[i % types.length], intensity: 0.8 }] })) };
    const req: RenderRequest = { timeline: tl, media, audioId: "song0", audioDuration: analysis.duration, aspect: "16:9", export: { resolution: 720, fps: 30 }, keepClipAudio: true, clipAudioVolume: 0.3 };
    const plan = planRender(req);
    const { job } = await render(req);
    const frames = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", job.output]).toString().trim());
    expect(frames).toBe(plan.totalFrames);
    if (process.env.BEATSYNC_KEEP) copyFileSync(job.output, process.env.BEATSYNC_KEEP);
  }, 300_000);

  it("framing moves a 16:9 clip inside a 9:16 frame (left / centre / right)", async () => {
    // left half red, right half blue
    const file = path.join(work, "halves.mp4");
    ff(["-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=4", "-f", "lavfi", "-i", "color=c=blue:s=320x360:r=30:d=4",
      "-filter_complex", "[0][1]overlay=x=320:y=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    copyFileSync(file, path.join(mediaDir, "halves"));
    const m: MediaItem = { id: "halves", kind: "video", name: "halves.mp4", mime: "video/mp4", size: 1, duration: 4e6, width: 640, height: 360 };
    const centre = async (x: number) => {
      const clip = { id: `f${x}`, mediaId: "halves", srcIn: 0, start: 0, end: 2_000_000, effects: [], transitionIn: { type: "cut" as const, duration: 0 }, pulses: [], framing: { x, y: 0, scale: 1 } };
      const { job } = await render({ timeline: { clips: [clip], duration: 2_000_000, fadeIn: 0, fadeOut: 0 }, media: [m], audioId: "song0", audioDuration: 2_000_000, aspect: "9:16", export: { resolution: 720, fps: 30 }, keepClipAudio: false, clipAudioVolume: 0 });
      // RGB of the centre pixel of frame 10
      const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "0.33", "-i", job.output, "-frames:v", "1", "-vf", "crop=2:2:iw/2:ih/2,format=rgb24", "-f", "rawvideo", "-"]);
      return [raw[0], raw[1], raw[2]];
    };
    const [left, mid, right] = [await centre(-1), await centre(0), await centre(1)];
    expect(left[0]).toBeGreaterThan(200); // red half fills the frame
    expect(left[2]).toBeLessThan(60);
    expect(right[2]).toBeGreaterThan(200); // blue half fills the frame
    expect(right[0]).toBeLessThan(60);
    // centred: the frame straddles the red/blue boundary
    expect(mid).not.toEqual(left);
  }, 300_000);

  it("uses only the trimmed section of the song, with fades", async () => {
    // 0–6 s silence, 6–20 s a 440 Hz tone: if the trim is ignored the export starts silent.
    const sr = 44100, x = new Float32Array(sr * 20);
    for (let i = 6 * sr; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    writeFileSync(path.join(mediaDir, "toneSong"), encodeWav(x, sr));
    const clip = { id: "t", mediaId: "vid1", srcIn: 0, start: 0, end: 8_000_000, effects: [], transitionIn: { type: "cut" as const, duration: 0 }, pulses: [] };
    const { job } = await render({
      timeline: { clips: [clip], duration: 8_000_000, fadeIn: 0, fadeOut: 0 }, media, audioId: "toneSong", audioDuration: 20_000_000,
      aspect: "16:9", export: { resolution: 720, fps: 30 }, keepClipAudio: false, clipAudioVolume: 0,
      audioStart: 6_000_000, audioFadeIn: 0, audioFadeOut: 2_000_000,
    });
    const rms = (from: number, dur: number) => {
      const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(from), "-t", String(dur), "-i", job.output, "-vn", "-ac", "1", "-f", "f32le", "-"]);
      const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
      return Math.sqrt(f.reduce((a, v) => a + v * v, 0) / Math.max(1, f.length));
    };
    const info = probe(job.output);
    expect(Math.abs(parseFloat(info.format.duration) - 8)).toBeLessThan(0.05);
    expect(rms(0.05, 0.5)).toBeGreaterThan(0.25); // tone from the very start ⇒ trim applied
    expect(rms(3, 1)).toBeGreaterThan(0.25);
    expect(rms(7.6, 0.35)).toBeLessThan(rms(3, 1) * 0.35); // fading out
  }, 300_000);

  it("cancels a running render", async () => {
    const { startRender, getJob, cancelRender } = await import("@/server/render");
    const { timeline } = generateTimeline({ analysis, media, settings: { ...DEFAULT_SETTINGS, preset: "cinematic" } });
    const st = await startRender({ timeline, media, audioId: "song0", audioDuration: analysis.duration, aspect: "9:16", export: { resolution: 1080, fps: 60 }, keepClipAudio: false, clipAudioVolume: 0 });
    await new Promise((r) => setTimeout(r, 600));
    expect(cancelRender(st.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(getJob(st.id)!.status.state).toBe("cancelled");
  }, 60_000);
});
