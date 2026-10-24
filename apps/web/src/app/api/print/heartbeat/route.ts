import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { printAgents, printers } from "@/db/schema";
import { authenticateAgent } from "@/lib/print/agent";
import { upsertDevices } from "@/lib/print/devices";
import { withTenant } from "@/lib/tenant-db";

const body = z.object({
  version: z.string().max(40).optional(),
  hostname: z.string().max(100).optional(),
  lan_ip: z.string().max(60).optional(),
  info: z.record(z.string(), z.unknown()).optional(),
  printers: z
    .array(z.object({
      key: z.string().min(1).max(100),
      online: z.boolean().optional(),
      paper_out: z.boolean().optional(),
      cover_open: z.boolean().optional(),
      error: z.string().max(200).optional(),
    }))
    .max(10)
    .default([]),
});

// Every 30 s: the agent's LAN details (for the Service panel) and the status of each of its printers.
export async function POST(req: Request) {
  const agent = await authenticateAgent(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const b = parsed.data;
  const now = new Date();
  await withTenant(agent.tenantId, async (tx) => {
    await tx.update(printAgents).set({ version: b.version, hostname: b.hostname, lanIp: b.lan_ip, info: b.info, lastSeenAt: now }).where(eq(printAgents.id, agent.id));
    await upsertDevices(tx, agent.tenantId, agent.id, b.printers.map((p) => ({ key: p.key })));
    for (const p of b.printers) {
      await tx
        .update(printers)
        .set({ lastStatus: { online: p.online, paperOut: p.paper_out, coverOpen: p.cover_open, error: p.error }, lastStatusAt: now })
        .where(and(eq(printers.agentId, agent.id), eq(printers.deviceKey, p.key)));
    }
  });
  return NextResponse.json({ ok: true });
}
