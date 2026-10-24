import { asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { PrintAgentsPanel } from "@/components/print-agents-panel";
import { navLinkClass } from "@/components/nav-link";
import { UserMenu } from "@/components/user-menu";
import { db } from "@/db";
import { organization, printAgentCommands, printAgents } from "@/db/schema";
import { requirePlatformAdmin } from "@/lib/admin";
import { agentViews } from "@/lib/print/views";
import { adminSendAgentCommand } from "../actions";

async function Agents() {
  await requirePlatformAdmin();
  // Platform view: every restaurant's print agents (a technician finds a Pi's IP and fixes it from a phone).
  const [agents, commands] = await Promise.all([
    db
      .select({ a: printAgents, tenantName: organization.name })
      .from(printAgents)
      .innerJoin(organization, eq(organization.id, printAgents.tenantId))
      .orderBy(asc(organization.name), asc(printAgents.createdAt)),
    db.select().from(printAgentCommands).orderBy(desc(printAgentCommands.createdAt)).limit(100),
  ]);
  const views = agentViews(agents.map(({ a, tenantName }) => ({ ...a, tenantName })), commands, 3);
  return (
    <>
      <h1 className="text-2xl font-semibold">Print agents</h1>
      <p className="text-sm text-muted-foreground">Every restaurant&apos;s kitchen print agent: where it is on the network and what it can be told to do.</p>
      <PrintAgentsPanel agents={views} sendCommand={adminSendAgentCommand} />
    </>
  );
}

export default function PrintingAdminPage() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 p-6">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3 text-sm">
        <Link href="/admin" className={navLinkClass}>← Platform admin</Link>
        <UserMenu />
      </nav>
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Agents />
      </Suspense>
    </main>
  );
}
