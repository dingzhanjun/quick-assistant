import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { blockedNumbers, calls, phoneNumbers, tenantSettings } from "@/db/schema";
import { AGENT, audit, maskPhone } from "@/lib/audit";
import { isAgentRequest } from "@/lib/agent-auth";
import { CALL_LIMITS } from "@/lib/call-limits";
import { phoneCandidates } from "@/lib/phone";

const body = z.object({
  to: z.string(),
  call_id: z.string().min(1).max(200),
  caller: z.string().max(100).optional(),
});

// The agent announces every inbound call here before talking. Answer: may this call proceed?
// Refusals are 200 with allowed=false so the agent can say a polite sentence and hang up.
export async function POST(req: Request) {
  if (!isAgentRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { to, call_id } = parsed.data;

  const candidates = phoneCandidates(to);
  const [number] = await db
    .select()
    .from(phoneNumbers)
    .where(inArray(phoneNumbers.e164, candidates.length ? candidates : ["-"]));
  if (!number) return NextResponse.json({ error: "unknown number" }, { status: 404 });
  const tenantId = number.tenantId;

  const [settings] = await db
    .select({ suspended: tenantSettings.suspended })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  if (settings?.suspended) return NextResponse.json({ error: "suspended" }, { status: 403 });

  const callerCandidates = parsed.data.caller ? phoneCandidates(parsed.data.caller) : [];
  const caller = callerCandidates[0] ?? null; // withheld / non-numeric caller ids are stored as null

  const decision = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"calls:" + tenantId}))`);

    // A retried start for the same call is not a second call.
    const [existing] = await tx.select({ id: calls.id }).from(calls).where(eq(calls.callId, call_id));
    if (existing) return { allowed: true as const, duplicate: true as const };

    if (caller) {
      const [blocked] = await tx
        .select({ e164: blockedNumbers.e164 })
        .from(blockedNumbers)
        .where(inArray(blockedNumbers.e164, callerCandidates));
      if (blocked) return { allowed: false as const, reason: "blocked" as const };

      const [{ recent }] = await tx
        .select({ recent: sql<number>`count(*)::int` })
        .from(calls)
        .where(and(eq(calls.callerNumber, caller), gt(calls.startedAt, new Date(Date.now() - 3600_000))));
      if (recent >= CALL_LIMITS.maxCallsPerCallerPerHour) {
        return { allowed: false as const, reason: "rate_limited" as const };
      }
    }

    const [{ active }] = await tx
      .select({ active: sql<number>`count(*)::int` })
      .from(calls)
      .where(
        and(
          eq(calls.tenantId, tenantId),
          isNull(calls.endedAt),
          gt(calls.startedAt, new Date(Date.now() - CALL_LIMITS.staleAfterMs)),
          ne(calls.callId, call_id),
        ),
      );
    if (active >= CALL_LIMITS.maxConcurrentPerTenant) {
      return { allowed: false as const, reason: "busy" as const };
    }

    await tx.insert(calls).values({ tenantId, callId: call_id, callerNumber: caller });
    return { allowed: true as const, duplicate: false as const };
  });

  const who = maskPhone(caller) ?? "withheld number";
  if (!decision.allowed) {
    await audit({
      action: "call.refused", actor: AGENT, tenantId, entityType: "call", entityId: call_id,
      summary: `Call from ${who} refused: ${decision.reason}`, details: { reason: decision.reason, caller: maskPhone(caller) },
    });
  } else if (!decision.duplicate) {
    await audit({
      action: "call.started", actor: AGENT, tenantId, entityType: "call", entityId: call_id,
      summary: `Call from ${who} started`, details: { caller: maskPhone(caller) },
    });
  }
  return NextResponse.json({ allowed: decision.allowed, ...(decision.allowed ? {} : { reason: decision.reason }) });
}
