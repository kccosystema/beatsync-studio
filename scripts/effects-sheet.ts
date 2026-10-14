/** Renders the sample footage with one effect per clip and writes a contact sheet (order printed). Usage: tsx scripts/effects-sheet.ts out.jpg */
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const work = mkdtempSync(path.join(os.tmpdir(), "beatsync-fx-"));
process.env.BEATSYNC_DATA_DIR = work;
const out = path.resolve(process.argv[2] ?? "effects-sheet.jpg");

async function main() {
  const { startRender, getJob } = await import("../src/server/render");
  const { EFFECTS } = await import("../src/lib/engine/effects");
  const dir = path.resolve("public/samples");
  mkdirSync(path.join(work, "media"), { recursive: true });
  copyFileSync(path.join(dir, "clip-1-testsrc.mp4"), path.join(work, "media", "v0"));
  copyFileSync(path.join(dir, "song.wav"), path.join(work, "media", "song"));
  const media = [{ id: "v0", kind: "video" as const, name: "testsrc", mime: "video/mp4", size: 0, duration: 12e6, width: 1280, height: 720 }];
  const beat = 468_750; // 128 BPM
  const len = 4 * beat;
  const clips = EFFECTS.map((e, i) => ({
    id: `fx-${e.type}`, mediaId: "v0", srcIn: 1_000_000, start: i * len, end: (i + 1) * len,
    effects: [{ type: e.type, intensity: 0.8 }], transitionIn: { type: "cut" as const, duration: 0 },
    pulses: [0, beat, 2 * beat, 3 * beat],
  }));
  const timeline = { clips, duration: clips.length * len, fadeIn: 0, fadeOut: 0 };
  const st = await startRender({ timeline, media, audioId: "song", audioDuration: timeline.duration, aspect: "16:9", export: { resolution: 720, fps: 30 }, keepClipAudio: false, clipAudioVolume: 0 });
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const s = getJob(st.id)!.status;
    if (s.state === "error") throw new Error(s.error);
    if (s.state === "done") break;
  }
  const file = getJob(st.id)!.output;
  // grab a frame ~60% into each clip, label it, tile
  const frames = clips.map((c, i) => {
    const f = path.join(work, `f${i}.png`);
    const t = ((c.start + len * 0.6) / 1e6).toFixed(3);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", t, "-i", file, "-frames:v", "1",
      "-vf", "scale=320:-1", f]);
    return f;
  });
  const cols = 6;
  const args = frames.flatMap((f) => ["-i", f]);
  const rows = Math.ceil(frames.length / cols);
  const layout = frames.map((_, i) => `${(i % cols) * 320}_${Math.floor(i / cols) * 180}`).join("|");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, "-filter_complex", `xstack=inputs=${frames.length}:layout=${layout}:fill=black,crop=${cols * 320}:${rows * 180}:0:0`, out]);
  console.log(`wrote ${out} — grid order (left→right, top→bottom): ${EFFECTS.map((e) => e.name).join(", ")}`);
}
main();
