import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { printers, printJobs } from "@/db/schema";
import { authenticateAgent } from "@/lib/print/agent";
import { withTenant } from "@/lib/tenant-db";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const agent = await authenticateAgent(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // only a ticket for one of THIS agent's printers
  const [job] = await withTenant(agent.tenantId, (tx) =>
    tx.select({ image: printJobs.image }).from(printJobs).innerJoin(printers, eq(printers.id, printJobs.printerId))
      .where(and(eq(printJobs.id, id), eq(printers.agentId, agent.id))),
  );
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new Response(new Uint8Array(job.image), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
}
