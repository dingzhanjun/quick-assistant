import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { LocalTime } from "@/components/local-time";
import { navLinkClass } from "@/components/nav-link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UserMenu } from "@/components/user-menu";
import { db } from "@/db";
import { jobs, organization } from "@/db/schema";
import { requirePlatformAdmin } from "@/lib/admin";
import { maskPhone } from "@/lib/audit";
import { jobsHealth } from "@/lib/jobs";
import { AuditPager } from "../audit/pager";
import { JobRowButtons, RetryAllButton } from "./job-buttons";

const PAGE_SIZE = 50;
const STATUSES = ["failed", "pending", "running", "done"] as const;
const LABEL: Record<string, string> = { failed: "Failed", pending: "Waiting", running: "Running", done: "Sent" };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

function href(q: Record<string, string | undefined>) {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
  return `/admin/jobs${p.size ? `?${p}` : ""}`;
}

async function Jobs({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePlatformAdmin();
  const raw = await searchParams;
  const status = (STATUSES as readonly string[]).includes(one(raw.status) ?? "") ? one(raw.status)! : one(raw.status) === "all" ? "all" : "failed";
  const type = one(raw.type) === "email" || one(raw.type) === "sms" ? (one(raw.type) as "email" | "sms") : null;
  const page = Math.max(1, Number(one(raw.page)) || 1);

  const conds: (SQL | undefined)[] = [];
  if (status !== "all") conds.push(eq(jobs.status, status as (typeof STATUSES)[number]));
  if (type) conds.push(eq(jobs.type, type));
  const where = and(...conds);

  const [health, rows, [{ total }], tenants] = await Promise.all([
    jobsHealth(),
    db.select().from(jobs).where(where).orderBy(desc(jobs.createdAt)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(jobs).where(where),
    db.select({ id: organization.id, name: organization.name }).from(organization),
  ]);
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const lagging = health.oldestDueSeconds > 120;
  const counts: Record<string, number> = { failed: health.failed, pending: health.pending, running: health.running };

  return (
    <>
      <h1 className="text-2xl font-semibold">Background jobs</h1>
      <p className="text-sm text-muted-foreground">
        Emails and text messages are queued and sent by the worker, with retries (30 s, 2 min, 10 min, 30 min, 2 h). A job that still
        fails after 5 attempts lands in <strong>Failed</strong> and is kept for 30 days. Fix the cause (provider key, credit, a wrong
        number), then retry it here.
      </p>

      <div role="status" className={`rounded-lg border p-3 text-sm ${lagging ? "border-destructive" : ""}`}>
        {lagging ? (
          <span className="font-medium text-destructive-text">
            The worker is not keeping up: {health.due} job{health.due === 1 ? " has" : "s have"} been due for up to {Math.round(health.oldestDueSeconds / 60)} min.
            Messages are not going out. Check <code>docker compose logs worker</code>.
          </span>
        ) : (
          <span className="font-medium text-success-text">Worker healthy.</span>
        )}{" "}
        <span className="text-muted-foreground">
          {health.pending} waiting · {health.running} running · {health.failed} failed
          {health.lastDoneAt && <> · last message sent <LocalTime iso={health.lastDoneAt.toISOString()} kind="datetime" /></>}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {[...STATUSES, "all" as const].map((s) => (
            <Link
              key={s}
              href={href({ status: s, type: type ?? undefined })}
              className={`rounded-full border px-3 py-1 ${s === status ? "bg-muted font-medium" : ""}`}
            >
              {s === "all" ? "All" : LABEL[s]}
              {counts[s] !== undefined && ` (${counts[s]})`}
            </Link>
          ))}
          <span className="mx-2 text-muted-foreground">|</span>
          {([null, "email", "sms"] as const).map((t) => (
            <Link key={t ?? "any"} href={href({ status, type: t ?? undefined })} className={`rounded-full border px-3 py-1 ${t === type ? "bg-muted font-medium" : ""}`}>
              {t === null ? "Emails and texts" : t === "email" ? "Emails" : "Texts"}
            </Link>
          ))}
        </div>
        <RetryAllButton type={type} count={health.failed} />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Queued</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>To</TableHead>
            <TableHead>What</TableHead>
            <TableHead>Restaurant</TableHead>
            <TableHead>Tries</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                {status === "failed" ? "No failed jobs. Everything that was queued has been sent." : "Nothing here."}
              </TableCell>
            </TableRow>
          )}
          {rows.map((j) => (
            <TableRow key={j.id} className="align-top">
              <TableCell className="whitespace-nowrap text-sm"><LocalTime iso={j.createdAt.toISOString()} kind="datetime" /></TableCell>
              <TableCell className="text-sm">{j.type === "sms" ? "Text" : "Email"}</TableCell>
              <TableCell className="break-all text-sm">{j.type === "sms" ? maskPhone(j.payload.to) : j.payload.to}</TableCell>
              <TableCell className="max-w-[14rem] text-sm">
                <div className="line-clamp-2">{j.type === "sms" ? j.payload.text : j.payload.subject}</div>
              </TableCell>
              <TableCell className="text-sm">{j.payload.tenantId ? (tenantName.get(j.payload.tenantId) ?? "(deleted)") : "—"}</TableCell>
              <TableCell className="text-sm">{j.attempts}/{j.maxAttempts}</TableCell>
              <TableCell className="text-sm">
                {LABEL[j.status]}
                {j.status === "pending" && j.attempts > 0 && (
                  <div className="text-xs text-muted-foreground">next try <LocalTime iso={j.runAt.toISOString()} kind="time" /></div>
                )}
                {j.lastError && <div className="max-w-[18rem] break-words text-xs text-destructive-text">{j.lastError}</div>}
                {(j.status === "failed" || j.status === "pending") && <JobRowButtons id={j.id} />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AuditPager page={page} pages={pages} path="/admin/jobs" query={Object.fromEntries(Object.entries({ status, type: type ?? "" }).filter(([, v]) => v)) as Record<string, string>} />
    </>
  );
}

export default function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 p-6">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3 text-sm">
        <Link href="/admin" className={navLinkClass}>← Platform admin</Link>
        <UserMenu />
      </nav>
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Jobs searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
