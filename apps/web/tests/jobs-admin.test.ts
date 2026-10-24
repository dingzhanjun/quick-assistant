// The dedicated worker and the failed-jobs page: queue health, retry / delete (audited, numbers masked), worker on/off.
// Needs a migrated Postgres (DATABASE_URL); creates its own jobs and removes them afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { and, eq, inArray, like } from "drizzle-orm";

const run = randomUUID().slice(0, 8);
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/admin.ts"), { namedExports: { requirePlatformAdmin: async () => ({ id: "adm", email: `admin-${run}@example.com`, name: "Admin" }) } });
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
process.env.SMS_PROVIDER = "log";

type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");
let J: typeof import("../src/lib/jobs");
let A: typeof import("../src/app/admin/jobs/actions");
const ids: string[] = [];

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  J = await import("../src/lib/jobs");
  A = await import("../src/app/admin/jobs/actions");
});
after(async () => {
  if (ids.length) await db.delete(S.jobs).where(inArray(S.jobs.id, ids));
  await db.delete(S.jobs).where(like(S.jobs.dedupeKey, `jobs-admin-${run}%`));
  await db.delete(S.auditLogs).where(like(S.auditLogs.actorLabel, `%${run}@example.com`));
  process.exit(0);
});

const mk = async (v: Partial<typeof S.jobs.$inferInsert> & { to?: string }) => {
  const [j] = await db.insert(S.jobs).values({
    type: "email", payload: { to: v.to ?? `to-${run}@example.com`, subject: "Subject", text: "Body" }, status: "failed", attempts: 5, lastError: "provider said no", ...v,
  }).returning();
  ids.push(j.id);
  return j;
};
const get = async (id: string) => (await db.select().from(S.jobs).where(eq(S.jobs.id, id)))[0];

test("worker on/off: default on, JOB_WORKER=off turns it off", () => {
  assert.equal(J.jobWorkerEnabled({}), true);
  assert.equal(J.jobWorkerEnabled({ JOB_WORKER: "on" }), true);
  assert.equal(J.jobWorkerEnabled({ JOB_WORKER: "off" }), false);
});

test("a web process with the worker off does not schedule sending on kick; with it on it does", () => {
  // (other test files share this database and send due jobs too, so look at what THIS process schedules, not at the rows)
  const original = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = (() => { scheduled++; return 0 as unknown as ReturnType<typeof setTimeout>; }) as unknown as typeof setTimeout; // swallowed: nothing is really sent
  try {
    process.env.JOB_WORKER = "off";
    J.kickJobs();
    assert.equal(scheduled, 0, "the web process must not send");
    delete process.env.JOB_WORKER;
    J.kickJobs();
    assert.equal(scheduled, 1);
  } finally {
    globalThis.setTimeout = original;
    delete process.env.JOB_WORKER;
  }
});

test("the worker drains a burst larger than one batch in one tick, and a runaway loop is bounded", async () => {
  const calls: number[] = [];
  const replies = [20, 20, 7];
  assert.equal(await J.drainBatches(async () => { calls.push(1); return replies.shift() ?? 0; }), 47);
  assert.equal(calls.length, 3, "stops at the first short batch");
  let n = 0;
  await J.drainBatches(async () => { n++; return 20; }, 20, 5);
  assert.equal(n, 5, "never loops more than `max` batches");
  assert.equal(await J.drainBatches(async () => 0), 0);
});

test("queue health shows a stuck worker as lag; the health endpoint turns 503", async () => {
  const stuck = await mk({ status: "pending", attempts: 0, runAt: new Date(Date.now() - 10 * 60_000) });
  const h = await J.jobsHealth();
  assert.ok(h.oldestDueSeconds >= 590, `lag ${h.oldestDueSeconds}`);
  assert.ok(h.due >= 1 && h.pending >= 1 && h.failed >= 0);
  const { GET } = await import("../src/app/api/health/worker/route");
  const res = await GET();
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { ok: boolean }).ok, false);
  // a job waiting for a RETRY in the future is not lag
  await db.update(S.jobs).set({ runAt: new Date(Date.now() + 3600_000) }).where(eq(S.jobs.id, stuck.id));
  if ((await J.jobsHealth()).due === 0) assert.equal((await GET()).status, 200);
});

test("retry puts a failed job back to run now; done or unknown jobs are refused; the audit trail masks numbers", async () => {
  const failedSms = await mk({ type: "sms", payload: { to: "+14045550133", text: "hello", tenantId: undefined } });
  const done = await mk({ status: "done", attempts: 1, lastError: null });
  assert.deepEqual(await A.retryJob(failedSms.id), { ok: true, count: 1 });
  const row = await get(failedSms.id);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.lastError, null);
  assert.ok(row.runAt.getTime() <= Date.now());
  assert.equal((await A.retryJob(done.id)).ok, false);
  assert.equal((await A.retryJob(randomUUID())).ok, false);
  const audits = await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.action, "admin.job_retried"), like(S.auditLogs.actorLabel, `%${run}@example.com`)));
  assert.ok(audits.length >= 1);
  assert.ok(audits.every((a) => !JSON.stringify(a).includes("5550133")), "the phone number is masked");
});

test("retry all failed of one type, and delete", async () => {
  // (the retry-all action works on EVERY failed job in the database, so only our own jobs are asserted on)
  const e = await mk({});
  const t = await mk({ type: "sms", payload: { to: "+14045550144", text: "x" } });
  const sms = await A.retryFailedJobs("sms"); // (only texts: other test files own failed EMAIL jobs in this shared database)
  assert.ok(sms.ok && sms.count >= 1);
  assert.equal((await get(t.id)).status, "pending");
  assert.equal((await get(e.id)).status, "failed", "the other type is untouched");

  const gone = await mk({});
  assert.deepEqual(await A.deleteJob(gone.id), { ok: true, count: 1 });
  assert.equal((await db.select().from(S.jobs).where(eq(S.jobs.id, gone.id))).length, 0);
  assert.equal((await A.deleteJob(gone.id)).ok, false);
  const running = await mk({ status: "running" });
  assert.equal((await A.deleteJob(running.id)).ok, false, "a running job is not deletable");
});
