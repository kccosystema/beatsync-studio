/**
 * Assembles app-build/ for the Mac app:
 *   app-build/server  ← .next/standalone + .next/static + public/ (minus sample media)
 *   app-build/bin     ← static ffmpeg + ffprobe (no Homebrew dylibs)
 * Run after `next build` (npm run app:dist does both).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "app-build");
const standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("Missing .next/standalone/server.js — run `next build` first.");
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
const server = path.join(out, "server");
mkdirSync(server, { recursive: true });
cpSync(standalone, server, { recursive: true });
cpSync(path.join(root, ".next", "static"), path.join(server, ".next", "static"), { recursive: true });
cpSync(path.join(root, "public"), path.join(server, "public"), {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}public${path.sep}samples`),
});
// Next's standalone trace can miss runtimes (e.g. app-route-turbo for API routes).
// Ship every production runtime so route handlers always load.
const runtimes = path.join("node_modules", "next", "dist", "compiled", "next-server");
for (const f of readdirSync(path.join(root, runtimes))) {
  if (f.endsWith(".runtime.prod.js")) cpSync(path.join(root, runtimes, f), path.join(server, runtimes, f));
}
// Never ship local render data, even if a trace picked it up.
rmSync(path.join(server, ".beatsync-data"), { recursive: true, force: true });

const bin = path.join(out, "bin");
mkdirSync(bin, { recursive: true });
const ffmpeg = require("ffmpeg-static");
const ffprobe = require("ffprobe-static").path;
cpSync(ffmpeg, path.join(bin, "ffmpeg"));
cpSync(ffprobe, path.join(bin, "ffprobe"));
for (const f of ["ffmpeg", "ffprobe"]) chmodSync(path.join(bin, f), 0o755);
console.log(`Assembled ${path.relative(root, out)}/ (server + ffmpeg/ffprobe)`);
