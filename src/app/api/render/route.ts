import { startRender } from "@/server/render";
import type { RenderRequest } from "@/lib/types";


export async function POST(req: Request) {
  let body: RenderRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const status = await startRender(body);
    return Response.json(status, { status: 202 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
