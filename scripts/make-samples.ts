/**
 * Generates royalty-free sample media for trying the app:
 *   samples/song.mp3      – 128 BPM synthetic track: quiet intro, build, loud drop, breakdown
 *   samples/clip-*.mp4    – six generated video clips (different looks/motion)
 *   samples/photo-*.png   – two stills
 * Usage: npm run samples
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] ?? "samples");
mkdirSync(out, { recursive: true });
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });

// ---- song
const sr = 44100, bpm = 128, seconds = 64;
const n = sr * seconds;
const L = new Float32Array(n);
const period = 60 / bpm;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const level = (t: number) => (t < 15 ? 0.3 : t < 22.5 ? 0.3 + ((t - 15) / 7.5) * 0.5 : t < 45 ? 1 : t < 52.5 ? 0.25 : 0.9);
const chords = [[220, 261.6, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 329.6]];
for (let i = 0; i < n; i++) {
  const t = i / sr;
  const bar = Math.floor(t / (period * 4)) % 4;
  let pad = 0;
  for (const f of chords[bar]) pad += Math.sin(2 * Math.PI * f * t) * 0.05 + Math.sin(2 * Math.PI * f * 2.001 * t) * 0.015;
  L[i] = pad * (0.6 + 0.4 * level(t));
}
for (let k = 0, t = 0.1; t < seconds; t += period / 2, k++) {
  const beat = k % 2 === 0;
  const lv = level(t);
  const s = Math.round(t * sr);
  const drums = t < 15 ? beat : true; // intro: kick only on beats, hats appear later
  if (beat && (t < 45 || t >= 52.5 || (k / 2) % 4 === 0)) {
    for (let i = 0; i < sr * 0.25 && s + i < n; i++) {
      const f = 50 + 110 * Math.exp(-i / (sr * 0.03));
      L[s + i] += lv * 0.9 * Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / (sr * 0.09));
    }
  }
  if (drums && t >= 15) for (let i = 0; i < sr * 0.04 && s + i < n; i++) L[s + i] += lv * 0.18 * rnd() * Math.exp(-i / (sr * 0.008));
  if (beat && (k / 2) % 2 === 1 && t >= 22.5 && (t < 45 || t >= 52.5))
    for (let i = 0; i < sr * 0.15 && s + i < n; i++) L[s + i] += lv * 0.35 * rnd() * Math.exp(-i / (sr * 0.05));
}
let peak = 0;
for (const v of L) peak = Math.max(peak, Math.abs(v));
const wav = Buffer.alloc(44 + n * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sr, 24);
wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round((L[i] / peak) * 0.89 * 32767), 44 + i * 2);
const wavPath = path.join(out, "song.wav");
writeFileSync(wavPath, wav);
ff(["-i", wavPath, "-c:a", "libmp3lame", "-b:a", "192k", path.join(out, "song.mp3")]);

// ---- clips
const clips: [string, string][] = [
  ["clip-1-testsrc", "testsrc2=s=1280x720:r=30:d=12"],
  ["clip-2-mandelbrot", "mandelbrot=s=1280x720:r=30:end_scale=0.2:inner=convergence,trim=duration=12"],
  ["clip-3-life", "life=s=320x180:r=30:mold=10:ratio=0.2:death_color=#1b0a3a:life_color=#22d3ee,scale=1280:720:flags=neighbor,trim=duration=12"],
  ["clip-4-gradient", "gradients=s=1280x720:r=30:speed=0.03:d=12"],
  ["clip-5-cellauto", "cellauto=s=1280x720:r=30:rule=110,negate,colorchannelmixer=rr=0.6:gg=0.3:bb=1,trim=duration=12"],
  ["clip-6-portrait", "testsrc=s=720x1280:r=30:d=12,hue=h=t*40"],
];
for (const [name, src] of clips) ff(["-f", "lavfi", "-i", src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", path.join(out, `${name}.mp4`)]);
ff(["-f", "lavfi", "-i", "gradients=s=1600x1200:c0=#8b5cf6:c1=#22d3ee:x0=0:y0=0:x1=1600:y1=1200,drawgrid=w=200:h=200:t=2:c=white@0.3", "-frames:v", "1", path.join(out, "photo-1.png")]);
ff(["-f", "lavfi", "-i", "mandelbrot=s=1200x1200:start_scale=1.5", "-frames:v", "1", path.join(out, "photo-2.png")]);
console.log(`Sample media written to ${out}`);
