import { desc, sql } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { navLinkClass } from "@/components/nav-link";
import { UserMenu } from "@/components/user-menu";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/db";
import { blockedNumbers, member, orders, organization, phoneNumbers, tenantSettings } from "@/db/schema";
import { requirePlatformAdmin } from "@/lib/admin";
import { getLlmConfig } from "@/lib/platform-settings";
import { BlockList } from "./block-list";
import { LlmSettings } from "./llm-settings";
import { TenantRow } from "./tenant-row";

// Inside a subquery an unqualified "id" is the SUBQUERY table's id (orders.id is a uuid, member.id another row), not the
// restaurant's, so the restaurant's id is always written out in full.
const orgId = sql.raw('"organization"."id"');

async function Tenants() {
  await requirePlatformAdmin();
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
      members: sql<number>`(select count(*)::int from ${member} where ${member.organizationId} = ${orgId})`,
      numbers: sql<string[]>`coalesce((select array_agg(${phoneNumbers.e164} order by ${phoneNumbers.createdAt}) from ${phoneNumbers} where ${phoneNumbers.tenantId} = ${orgId}), '{}')`,
      orders: sql<number>`(select count(*)::int from ${orders} where ${orders.tenantId} = ${orgId})`,
      transferNumber: sql<string | null>`(select ${tenantSettings.transferNumber} from ${tenantSettings} where ${tenantSettings.tenantId} = ${orgId})`,
      suspended: sql<boolean>`coalesce((select ${tenantSettings.suspended} from ${tenantSettings} where ${tenantSettings.tenantId} = ${orgId}), false)`,
    })
    .from(organization)
    .orderBy(desc(organization.createdAt));

  const llm = await getLlmConfig();
  const blocked = await db.select({ e164: blockedNumbers.e164, reason: blockedNumbers.reason }).from(blockedNumbers);

  return (
    <>
      <LlmSettings provider={llm.provider} model={llm.model} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-2xl font-semibold">Platform admin</h1>
        <div className="flex gap-4 whitespace-nowrap">
          <Link href="/admin/printing" className="text-sm underline">
            Print agents →
          </Link>
          <Link href="/admin/audit" className="text-sm underline">
            Audit log →
          </Link>
          <Link href="/admin/jobs" className="text-sm underline">
            Email &amp; text queue →
          </Link>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Suspending a restaurant stops its phone agent from answering and taking orders.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Restaurant</TableHead>
            <TableHead>Members</TableHead>
            <TableHead>Agent numbers</TableHead>
            <TableHead>Orders</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((t) => (
            <TenantRow key={t.id} t={{ ...t, createdAt: t.createdAt.toISOString() }} />
          ))}
        </TableBody>
      </Table>
      <BlockList blocked={blocked} />
    </>
  );
}

export default function AdminPage() {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-4 p-6">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3 text-sm">
        <Link href="/dashboard" className={navLinkClass}>
          ← Restaurant dashboard
        </Link>
        <UserMenu />
      </nav>
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Tenants />
      </Suspense>
    </main>
  );
}
