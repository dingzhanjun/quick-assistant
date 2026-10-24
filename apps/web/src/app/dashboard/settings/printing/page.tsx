import { asc, desc, eq } from "drizzle-orm";
import { Suspense } from "react";
import { printAgentCommands, printAgents, printers, tenantSettings } from "@/db/schema";
import { isOwner } from "@/lib/role-utils";
import { agentRelease } from "@/lib/print/release";
import { agentViews } from "@/lib/print/views";
import { requireTenant } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant-db";
import { Printing } from "../printing";

async function PrintingContent() {
  const { tenantId, role } = await requireTenant();
  if (!isOwner(role)) {
    return <p className="text-muted-foreground">Only the restaurant owner can change settings.</p>;
  }
  const [[settings], agentRows, printerRows, commandRows] = await withTenant(tenantId, (db) =>
    Promise.all([
      db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)),
      // token / pairing hashes are not selectable by the restaurant role (column grants), so list the columns
      db
        .select({
          id: printAgents.id, name: printAgents.name, version: printAgents.version, hostname: printAgents.hostname, lanIp: printAgents.lanIp,
          lastSeenAt: printAgents.lastSeenAt, revokedAt: printAgents.revokedAt, pairingExpiresAt: printAgents.pairingExpiresAt,
        })
        .from(printAgents)
        .where(eq(printAgents.tenantId, tenantId))
        .orderBy(asc(printAgents.createdAt)),
      db.select().from(printers).where(eq(printers.tenantId, tenantId)).orderBy(asc(printers.createdAt)),
      db.select().from(printAgentCommands).where(eq(printAgentCommands.tenantId, tenantId)).orderBy(desc(printAgentCommands.createdAt)).limit(30),
    ]),
  );

  const agents = agentViews(agentRows, commandRows);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const printerViews = printerRows.map((p) => ({
    id: p.id, name: p.name, agentName: p.agentId ? (agentById.get(p.agentId)?.name ?? null) : null, paperWidthMm: p.paperWidthMm,
    copies: p.copies, enabled: p.enabled, status: p.lastStatus, agentOnline: p.agentId ? (agentById.get(p.agentId)?.online ?? false) : false,
  }));

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Kitchen printing</h2>
      <Printing
        timing={settings?.printTiming ?? "immediate"}
        agents={agents}
        printers={printerViews}
        serverUrl={process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}
        installBase={agentRelease()?.baseUrl ?? ""}
      />
    </section>
  );
}

export default function PrintingPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <PrintingContent />
    </Suspense>
  );
}
