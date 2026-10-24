import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { printAgentCommands } from "@/db/schema";
import { authenticateAgent } from "@/lib/print/agent";
import { withTenant } from "@/lib/tenant-db";

const body = z.object({ ok: z.boolean(), output: z.string().max(20_000).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const agent = await authenticateAgent(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const done = await withTenant(agent.tenantId, (tx) =>
    tx.update(printAgentCommands)
      .set({ status: parsed.data.ok ? "done" : "failed", result: parsed.data.output ?? null, finishedAt: new Date() })
      .where(and(eq(printAgentCommands.id, id), eq(printAgentCommands.agentId, agent.id), eq(printAgentCommands.status, "sent")))
      .returning({ id: printAgentCommands.id }),
  );
  return done.length ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}
