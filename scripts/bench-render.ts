/** Renders the sample project through the real pipeline and reports timings. Usage: tsx scripts/bench-render.ts [res] [fps] */
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, readFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const res = Number(process.argv[2] ?? 1080) as 720 | 1080;
const fps = Number(process.argv[3] ?? 30) as 24 | 30 | 60;
const work = mkdtempSync(path.join(os.tmpdir(), "beatsync-bench-"));
process.env.BEATSYNC_DATA_DIR = work;

async function main() {
  const { analyzeAudio } = await import("../src/lib/audio/analyze");
  const { generateTimeline } = await import("../src/lib/engine/generate");
  const { startRender, getJob } = await import("../src/server/render");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const dir = path.resolve("public/samples");
  const wav = readFileSync(path.join(dir, "song.wav"));
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
  const samples = Float32Array.from(pcm, (v) => v / 32768);
  const analysis = analyzeAudio(samples, 44100);
  const clips = ["clip-1-testsrc", "clip-2-mandelbrot", "clip-3-life", "clip-4-gradient", "clip-5-cellauto", "clip-6-portrait"];
  mkdirSync(path.join(work, "media"), { recursive: true });
  const media = clips.map((c, i) => {
    copyFileSync(path.join(dir, `${c}.mp4`), path.join(work, "media", `v${i}`));
    const [w, h] = c.includes("portrait") ? [720, 1280] : [1280, 720];
    return { id: `v${i}`, kind: "video" as const, name: c, mime: "video/mp4", size: 0, duration: 12e6, width: w, height: h, motion: 0.4 };
  });
  copyFileSync(path.join(dir, "song.wav"), path.join(work, "media", "song"));
  const { timeline } = generateTimeline({ analysis, media, settings: { ...DEFAULT_SETTINGS, preset: "musicvideo" } });
  const t0 = Date.now();
  const st = await startRender({ timeline, media, audioId: "song", audioDuration: analysis.duration, aspect: "16:9", export: { resolution: res, fps }, keepClipAudio: false, clipAudioVolume: 0 });
  let stage = "";
  let stageStart = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 200));
    const s = getJob(st.id)!.status;
    const key = s.stage.replace(/\(\d+\/\d+\)/, "");
    if (key !== stage) {
      if (stage) console.log(`  ${stage.padEnd(36)} ${((Date.now() - stageStart) / 1000).toFixed(1)}s`);
      stage = key; stageStart = Date.now();
    }
    if (s.state === "done" || s.state === "error") {
      console.log(`${res}p${fps}: ${s.state} in ${((Date.now() - t0) / 1000).toFixed(1)}s for ${(analysis.duration / 1e6).toFixed(0)}s of video, ${timeline.clips.length} clips ${s.error ?? ""}`);
      break;
    }
  }
  execFileSync("rm", ["-rf", work]);
}
main();
