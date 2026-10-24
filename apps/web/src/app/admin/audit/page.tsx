import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { LocalTime } from "@/components/local-time";
import { navLinkClass } from "@/components/nav-link";
import { UserMenu } from "@/components/user-menu";
import { Disclosure } from "@/components/ui/disclosure";
import { AuditFilters } from "./filters";
import { AuditPager } from "./pager";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/db";
import { auditLogs, organization } from "@/db/schema";
import { requirePlatformAdmin } from "@/lib/admin";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

const PAGE_SIZE = 50;
type Params = { tenant?: string; action?: string; actor?: string; q?: string; from?: string; to?: string; page?: string };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const validDate = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : undefined);
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function AuditLog({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePlatformAdmin();
  const raw = await searchParams;
  const p: Params = Object.fromEntries(
    ["tenant", "action", "actor", "q", "from", "to", "page"].map((k) => [k, one(raw[k])]),
  );

  const conds: (SQL | undefined)[] = [];
  if (p.tenant === "none") conds.push(sql`${auditLogs.tenantId} is null`);
  else if (p.tenant) conds.push(eq(auditLogs.tenantId, p.tenant));
  if (p.action) conds.push(p.action.endsWith(".*") ? ilike(auditLogs.action, `${esc(p.action.slice(0, -1))}%`) : eq(auditLogs.action, p.action));
  if (p.actor) conds.push(ilike(auditLogs.actorLabel, `%${esc(p.actor)}%`));
  if (p.q) conds.push(or(ilike(auditLogs.summary, `%${esc(p.q)}%`), ilike(auditLogs.entityId, `%${esc(p.q)}%`)));
  const from = validDate(p.from), to = validDate(p.to);
  if (from) conds.push(gte(auditLogs.createdAt, from));
  if (to) conds.push(lt(auditLogs.createdAt, new Date(to.getTime() + 86_400_000))); // inclusive of the end day
  const where = and(...conds);

  const page = Math.max(1, Number(p.page) || 1);
  const [rows, [{ total }], tenants] = await Promise.all([
    db
      .select({ log: auditLogs, tenantName: organization.name })
      .from(auditLogs)
      .leftJoin(organization, eq(organization.id, auditLogs.tenantId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(auditLogs).where(where),
    db.select({ id: organization.id, name: organization.name }).from(organization).orderBy(organization.name),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const groups = [...new Set(Object.keys(AUDIT_ACTIONS).map((a) => a.split(".")[0]))];

  return (
    <>
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <p className="text-sm text-muted-foreground">
        Every order, menu, settings, team, call and admin action, newest first. Entries cannot be edited or deleted
        from the app. Caller numbers are masked.
      </p>
      <AuditFilters
        tenants={tenants}
        actionGroups={groups}
        actions={Object.entries(AUDIT_ACTIONS).map(([key, label]) => ({ key, label }))}
        initial={{ tenant: p.tenant ?? "", action: p.action ?? "", actor: p.actor ?? "", q: p.q ?? "", from: p.from ?? "", to: p.to ?? "" }}
        total={total}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Restaurant</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>What</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">No entries match.</TableCell>
            </TableRow>
          )}
          {rows.map(({ log, tenantName }) => (
            <TableRow key={log.id} className="align-top">
              <TableCell className="whitespace-nowrap text-sm"><LocalTime iso={log.createdAt.toISOString()} kind="datetime" /></TableCell>
              <TableCell className="text-sm">{tenantName ?? (log.tenantId ? <span className="text-muted-foreground">{log.tenantId} (deleted)</span> : "—")}</TableCell>
              <TableCell className="text-sm">
                {log.actorLabel ?? "—"}
                <div className="text-xs text-muted-foreground">{log.actorType}</div>
              </TableCell>
              <TableCell className="font-mono text-xs">{log.action}</TableCell>
              <TableCell className="text-sm">
                {log.summary}
                {log.details && (
                  <Disclosure summary="details" bordered={false} className="mt-1 text-xs [&_.rs-panel-header]:px-0 [&_.rs-panel-header]:py-1 [&_.rs-panel-body]:px-0 [&_.rs-panel-body]:py-1">
                    <pre className="max-w-md overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(log.details, null, 2)}</pre>
                  </Disclosure>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AuditPager page={page} pages={pages} query={Object.fromEntries(Object.entries(p).filter(([k, v]) => v && k !== "page")) as Record<string, string>} />
    </>
  );
}

export default function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 p-6">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3 text-sm">
        <Link href="/admin" className={navLinkClass}>← Platform admin</Link>
        <UserMenu />
      </nav>
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <AuditLog searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
