import { spawn } from "node:child_process";
import { connection } from "next/server";


/** Reports whether the local FFmpeg render worker is usable. */
export async function GET() {
  await connection(); // always evaluate at request time (never prerender)
  const version = await new Promise<string | null>((resolve) => {
    const p = spawn(/*turbopackIgnore: true*/ process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-version"]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(null));
    p.on("close", (code) => resolve(code === 0 ? out.split("\n")[0] : null));
  });
  const encoders = version
    ? await new Promise<string>((resolve) => {
        const p = spawn(/*turbopackIgnore: true*/ process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-encoders"]);
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("error", () => resolve(""));
        p.on("close", () => resolve(out));
      })
    : "";
  return Response.json({
    ffmpeg: version,
    libx264: /libx264/.test(encoders),
    aac: /\baac\b/.test(encoders),
  });
}
