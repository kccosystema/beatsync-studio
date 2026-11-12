/** Fails if the bundled FFmpeg lacks anything the exporter uses, or links non-system libraries. */
import { execFileSync } from "node:child_process";
import path from "node:path";

const bin = path.resolve(import.meta.dirname, "..", "app-build", "bin");
const ffmpeg = path.join(bin, "ffmpeg"), ffprobe = path.join(bin, "ffprobe");
const run = (b, args) => execFileSync(b, args, { encoding: "utf8" });
const problems = [];
const encoders = run(ffmpeg, ["-hide_banner", "-encoders"]);
for (const e of ["libx264", "aac", "pcm_s16le"]) if (!new RegExp(`\\s${e}\\s`).test(encoders)) problems.push(`encoder ${e}`);
const filters = run(ffmpeg, ["-hide_banner", "-filters"]).split("\n").map((l) => l.trim().split(/\s+/)[1]);
for (const f of ["zoompan", "xfade", "tpad", "eq", "hue", "rgbashift", "noise", "blend", "hstack", "vstack", "concat", "afade", "atrim", "apad", "amix", "aresample", "settb", "crop", "scale", "fps", "reverse", "trim", "setsar", "format", "split", "hflip", "vflip"])
  if (!filters.includes(f)) problems.push(`filter ${f}`);
for (const b of [ffmpeg, ffprobe]) {
  const libs = run("otool", ["-L", b]).split("\n").slice(1).map((l) => l.trim().split(" ")[0]).filter(Boolean);
  for (const l of libs) if (!l.startsWith("/usr/lib/") && !l.startsWith("/System/")) problems.push(`${path.basename(b)} links ${l}`);
}
run(ffprobe, ["-version"]);
if (problems.length) {
  console.error("Bundled FFmpeg is not usable:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("Bundled FFmpeg OK:", run(ffmpeg, ["-hide_banner", "-version"]).split("\n")[0]);
