import { promises as fs } from "node:fs";
import { isSafeId, mediaPath, saveUpload } from "@/server/render";


/** HEAD: does the render worker already have this asset? */
export async function HEAD(_req: Request, ctx: RouteContext<"/api/media/[id]">) {
  const { id } = await ctx.params;
  if (!isSafeId(id)) return new Response(null, { status: 400 });
  try {
    const st = await fs.stat(mediaPath(id));
    return new Response(null, { status: 200, headers: { "x-size": String(st.size) } });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/** PUT: stream an asset (raw body) to the local render worker's media cache. */
export async function PUT(req: Request, ctx: RouteContext<"/api/media/[id]">) {
  const { id } = await ctx.params;
  if (!isSafeId(id)) return Response.json({ error: "Invalid id" }, { status: 400 });
  if (!req.body) return Response.json({ error: "Empty body" }, { status: 400 });
  try {
    const bytes = await saveUpload(id, req.body);
    return Response.json({ id, bytes });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
