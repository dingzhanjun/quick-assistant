import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { AGENT, audit } from "@/lib/audit";
import { isAgentRequest } from "@/lib/agent-auth";

const body = z.object({ call_id: z.string().min(1).max(200) });

// The agent reports the end of a call so it stops counting towards the restaurant's concurrency limit.
export async function POST(req: Request) {
  if (!isAgentRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const [ended] = await db
    .update(calls)
    .set({ endedAt: new Date() })
    .where(and(eq(calls.callId, parsed.data.call_id), isNull(calls.endedAt)))
    .returning({ tenantId: calls.tenantId, startedAt: calls.startedAt, endedAt: calls.endedAt });
  if (ended) {
    const secs = Math.round((ended.endedAt!.getTime() - ended.startedAt.getTime()) / 1000);
    await audit({
      action: "call.ended", actor: AGENT, tenantId: ended.tenantId, entityType: "call", entityId: parsed.data.call_id,
      summary: `Call ended after ${secs}s`, details: { seconds: secs },
    });
  }
  return NextResponse.json({ ok: true });
}
