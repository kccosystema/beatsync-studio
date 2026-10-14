import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { getJob } from "@/server/render";


export async function GET(req: Request, ctx: RouteContext<"/api/render/[id]/file">) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job || job.status.state !== "done") return Response.json({ error: "Export not ready" }, { status: 404 });
  const st = await fs.stat(job.output);
  const name = new URL(req.url).searchParams.get("name")?.replace(/[^\w.\- ]+/g, "").trim() || "beatsync-export";
  const stream = Readable.toWeb(createReadStream(job.output)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(st.size),
      "content-disposition": `attachment; filename="${name}.mp4"`,
      "cache-control": "no-store",
    },
  });
}
