// Background jobs: retries with backoff, no double sends, dedupe, crash recovery, unacknowledged-order alerts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";

const run = randomUUID().slice(0, 8);
const T = `job-${run}`;
let db: typeof import("../src/db")["db"];
let S: typeof import("../src/db/schema");
let J: typeof import("../src/lib/jobs");

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  J = await import("../src/lib/jobs");
  await db.insert(S.organization).values({ id: T, name: `Jobs ${run}`, slug: T, createdAt: new Date() });
  await db.insert(S.tenantSettings).values({ tenantId: T, notifyEmails: `kitchen-${run}@example.com` });
});
after(async () => {
  await db.delete(S.jobs).where(sql`${S.jobs.payload}->>'tenantId' = ${T} or ${S.jobs.payload}->>'to' like ${"%" + run + "%"}`);
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  await db.delete(S.organization).where(eq(S.organization.id, T));
  process.exit(0);
});

const mine = () => sql`${S.jobs.payload}->>'to' like ${"%" + run + "%"}`;
const rows = () => db.select().from(S.jobs).where(mine());
const clearMine = () => db.delete(S.jobs).where(mine());
const email = (n: string, extra = {}) => ({ to: `${n}-${run}@example.com`, subject: `s ${n}`, text: "body", tenantId: T, ...extra });

test("a queued email is sent once and marked done", async () => {
  await clearMine();
  await J.enqueueEmail(email("ok"));
  const sent: string[] = [];
  const n = await J.processDueJobs(async (to) => void sent.push(to));
  assert.ok(n >= 1);
  assert.deepEqual(sent.filter((t) => t.includes(run)), [`ok-${run}@example.com`]);
  const [job] = await rows();
  assert.deepEqual([job.status, job.attempts], ["done", 1]);
  assert.equal(await J.processDueJobs(async () => assert.fail("sent twice")), 0 + (await J.processDueJobs(async () => {})));
});

test("a failing provider is retried with growing delays, then given up on with an audit entry", async () => {
  await clearMine();
  await J.enqueueEmail(email("flaky"));
  await db.update(S.jobs).set({ maxAttempts: 3 }).where(mine());
  const failing = async () => { throw new Error("provider down"); };

  await J.processDueJobs(failing);
  let [job] = await rows();
  assert.deepEqual([job.status, job.attempts, job.lastError], ["pending", 1, "provider down"]);
  assert.ok(job.runAt.getTime() > Date.now() + 20_000, "first retry should be ~30 s away");
  assert.equal((await J.processDueJobs(failing)) >= 0, true);
  [job] = await rows();
  assert.equal(job.attempts, 1, "a job that is not due yet must not be retried early");

  for (const expect of [2, 3]) {
    await db.update(S.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(mine());
    await J.processDueJobs(failing);
    [job] = await rows();
    assert.equal(job.attempts, expect);
  }
  assert.equal(job.status, "failed");
  const [log] = await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, T), eq(S.auditLogs.action, "system.job_failed")));
  assert.match(log.summary, /could not be delivered after 3 attempts/);

  // a later success on a retry: attempts recorded, error cleared
  await clearMine();
  await J.enqueueEmail(email("recovers"));
  let n = 0;
  await J.processDueJobs(async () => { if (n++ === 0) throw new Error("blip"); });
  await db.update(S.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(mine());
  await J.processDueJobs(async () => {});
  [job] = await rows();
  assert.deepEqual([job.status, job.attempts, job.lastError], ["done", 2, null]);
});

test("two workers racing for the same job send it only once", async () => {
  await clearMine();
  await J.enqueueEmail(email("race"));
  let sends = 0;
  const slow = async () => { sends++; await new Promise((r) => setTimeout(r, 150)); };
  await Promise.all([J.processDueJobs(slow), J.processDueJobs(slow), J.processDueJobs(slow)]);
  assert.equal(sends, 1);
});

test("the same dedupe key queues one email; a crashed worker's job is picked up again", async () => {
  await clearMine();
  assert.equal(await J.enqueueEmail(email("dupe"), { dedupeKey: `t:${run}` }), true);
  assert.equal(await J.enqueueEmail(email("dupe"), { dedupeKey: `t:${run}` }), false);
  assert.equal((await rows()).length, 1);

  await db.update(S.jobs).set({ status: "running", lockedAt: new Date(Date.now() - 10 * 60_000), attempts: 1 }).where(mine());
  const sent: string[] = [];
  await J.processDueJobs(async (to) => void sent.push(to));
  assert.ok(sent.some((t) => t.includes(run)), "a job stuck in 'running' was never recovered");
});

test("an order nobody acknowledges gets ONE reminder; acknowledged or quiet restaurants get none", async () => {
  await clearMine();
  await db.delete(S.orders).where(eq(S.orders.tenantId, T));
  const old = new Date(Date.now() - 10 * 60_000);
  const [stale] = await db.insert(S.orders).values({ tenantId: T, orderNumber: 1, customerName: "Pat", createdAt: old }).returning();
  const [handled] = await db.insert(S.orders).values({ tenantId: T, orderNumber: 2, createdAt: old, status: "preparing" }).returning();
  await db.insert(S.orders).values({ tenantId: T, orderNumber: 3 }); // fresh: not due yet

  assert.equal(await J.alertUnacknowledgedOrders(5, T), 1);
  const mails = await rows();
  assert.equal(mails.length, 1);
  assert.match(mails[0].payload.subject ?? "", /Order #1 NOT acknowledged/);
  assert.match(mails[0].payload.text, /still marked "new"/);
  assert.equal(await J.alertUnacknowledgedOrders(5, T), 0, "the reminder must be sent only once");
  const [after1] = await db.select().from(S.orders).where(eq(S.orders.id, stale.id));
  assert.ok(after1.unackAlertedAt);
  const [h] = await db.select().from(S.orders).where(eq(S.orders.id, handled.id));
  assert.equal(h.unackAlertedAt, null);
  const logs = await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, T), eq(S.auditLogs.action, "order.unacknowledged")));
  assert.equal(logs.length, 1);

  // restaurant switched order emails off: audited, but no email
  await clearMine();
  await db.update(S.tenantSettings).set({ notifyNewOrders: false }).where(eq(S.tenantSettings.tenantId, T));
  await db.insert(S.orders).values({ tenantId: T, orderNumber: 4, createdAt: old });
  assert.equal(await J.alertUnacknowledgedOrders(5, T), 1);
  assert.equal((await rows()).length, 0);
});
