import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { organization, printAgents } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hashCode, hashSecret, newToken, pairRateLimited } from "@/lib/print/agent";
import { upsertDevices } from "@/lib/print/devices";
import { withTenant } from "@/lib/tenant-db";

const body = z.object({
  code: z.string().min(4).max(20),
  version: z.string().max(40).optional(),
  hostname: z.string().max(100).optional(),
  lan_ip: z.string().max(60).optional(),
  devices: z.array(z.object({ key: z.string().min(1).max(100), name: z.string().max(100).optional() })).max(10).default([]),
});

// Swaps the one-time pairing code (made by the restaurant owner in Settings -> Printing) for the agent's token and
// registers the USB printers the agent found. The code works once and for 15 minutes.
export async function POST(req: Request) {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (pairRateLimited(ip)) return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { code, version, hostname, lan_ip, devices } = parsed.data;

  const token = newToken();
  // Single UPDATE: only a code that is unused and unexpired matches, so two agents cannot both claim it.
  const [agent] = await db
    .update(printAgents)
    .set({ tokenHash: hashSecret(token), pairingCodeHash: null, pairingExpiresAt: null, version, hostname, lanIp: lan_ip, lastSeenAt: new Date() })
    .where(and(eq(printAgents.pairingCodeHash, hashCode(code)), gt(printAgents.pairingExpiresAt, new Date()), isNull(printAgents.revokedAt)))
    .returning({ id: printAgents.id, tenantId: printAgents.tenantId, name: printAgents.name });
  if (!agent) return NextResponse.json({ error: "invalid_or_expired_code" }, { status: 403 });

  await withTenant(agent.tenantId, (tx) => upsertDevices(tx, agent.tenantId, agent.id, devices));
  const [tenant] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, agent.tenantId));
  await audit({
    action: "print.agent_paired", actor: { type: "system", label: "print agent" }, tenantId: agent.tenantId,
    entityType: "print_agent", entityId: agent.id, summary: `Print agent "${agent.name}" paired (${devices.length} printer(s) found)`,
    details: { version: version ?? null, hostname: hostname ?? null },
  });
  return NextResponse.json({ token, agent_id: agent.id, restaurant: tenant?.name ?? null });
}
