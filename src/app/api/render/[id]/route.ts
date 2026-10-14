import { cancelRender, getJob } from "@/server/render";


export async function GET(_req: Request, ctx: RouteContext<"/api/render/[id]">) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return Response.json({ error: "Unknown render job" }, { status: 404 });
  return Response.json(job.status, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/render/[id]">) {
  const { id } = await ctx.params;
  const ok = cancelRender(id);
  return Response.json({ cancelled: ok }, { status: ok ? 200 : 409 });
}
