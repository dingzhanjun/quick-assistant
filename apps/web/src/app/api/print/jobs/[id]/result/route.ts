import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent } from "@/lib/print/agent";
import { finishJob } from "@/lib/print/queue";

const body = z.object({ ok: z.boolean(), error: z.string().max(300).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const agent = await authenticateAgent(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = await finishJob(agent, id, parsed.data.ok, parsed.data.error);
  return r === "ok" ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}
