import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs, organization, printJobs, rateLimit, tenantSettings } from "@/db/schema";
import { audit, maskPhone } from "./audit";
import { sendEmail } from "./email";
import { recipientsFor } from "./recipients";
import { sendSms } from "./sms";

// Background work with retries. Emails are queued (the order is already saved; a mail provider hiccup must not lose
// the notification) and a worker sends them, retrying with growing delays. Several web processes can run the worker:
// jobs are claimed with FOR UPDATE SKIP LOCKED, so nothing is sent twice.
export const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200]; // after attempt 1, 2, ... (max attempts = 5)
const STUCK_AFTER_MINUTES = 5; // a job "running" this long belongs to a crashed process: run it again

export type EmailJob = { to: string; subject: string; text: string; tenantId?: string };
type Sender = (to: string, subject: string, text: string) => Promise<void>;
type Texter = (to: string, text: string) => Promise<void>;
export type SmsJob = { to: string; text: string; tenantId?: string; orderId?: string };

// A text message to the customer (their order link), sent by the same worker with the same retries as email.
export async function enqueueSms(job: SmsJob, opts: { dedupeKey?: string } = {}): Promise<boolean> {
  const inserted = await db
    .insert(jobs)
    .values({ type: "sms", payload: job, dedupeKey: opts.dedupeKey })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return inserted.length > 0;
}

export async function enqueueEmail(job: EmailJob, opts: { dedupeKey?: string } = {}): Promise<boolean> {
  const inserted = await db
    .insert(jobs)
    .values({ type: "email", payload: job, dedupeKey: opts.dedupeKey })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return inserted.length > 0;
}

// Does THIS process run the job worker? Default yes (local development, a single server). In production the compose file starts a
// dedicated `worker` container (JOB_WORKER=on) and sets JOB_WORKER=off on the web containers, so sending never competes with requests.
export const jobWorkerEnabled = (env: Record<string, string | undefined> = process.env) => env.JOB_WORKER !== "off";

// Send what was just queued without waiting for the next worker tick (fire and forget, never throws). A process without the worker
// does nothing: the dedicated worker picks the job up on its next tick (a couple of seconds).
export function kickJobs() {
  if (!jobWorkerEnabled()) return;
  setTimeout(() => void processDueJobs().catch((e) => console.error("[jobs] kick failed", e)), 0);
}

type Claimed = { id: string; type: string; payload: EmailJob & SmsJob; attempts: number; max_attempts: number };

async function claim(limit: number): Promise<Claimed[]> {
  const rows = await db.execute<Claimed>(sql`
    update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
    where id in (
      select id from jobs
      where (status = 'pending' and run_at <= now())
         or (status = 'running' and locked_at < now() - make_interval(mins => ${STUCK_AFTER_MINUTES}))
      order by run_at
      limit ${limit}
      for update skip locked
    )
    returning id, type, payload, attempts, max_attempts`);
  return [...rows];
}

// Runs every job that is due. Returns how many were attempted.
export async function processDueJobs(send: Sender = sendEmail, limit = 20, text: Texter = sendSms): Promise<number> {
  const due = await claim(limit);
  for (const j of due) {
    try {
      if (j.type === "sms") await text(j.payload.to, j.payload.text);
      else await send(j.payload.to, j.payload.subject, j.payload.text);
      await db.update(jobs).set({ status: "done", completedAt: new Date(), lastError: null }).where(eq(jobs.id, j.id));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (j.attempts >= j.max_attempts) {
        await db.update(jobs).set({ status: "failed", lastError: message.slice(0, 500) }).where(eq(jobs.id, j.id));
        const sms = j.type === "sms";
        const who = sms ? maskPhone(j.payload.to) : j.payload.to; // phone numbers are never written in full to logs or the audit trail
        console.error(`[jobs] giving up on ${j.id} (${who}) after ${j.attempts} attempts: ${message}`);
        await audit({
          action: "system.job_failed", actor: { type: "system", label: "job worker" }, tenantId: j.payload.tenantId ?? null,
          entityType: "job", entityId: j.id,
          summary: `${sms ? "Text message" : "Email"} to ${who} could not be delivered after ${j.attempts} attempts`,
          details: sms ? { orderId: j.payload.orderId ?? null, error: message.slice(0, 300) } : { subject: j.payload.subject, error: message.slice(0, 300) },
        });
      } else {
        const delay = BACKOFF_SECONDS[Math.min(j.attempts - 1, BACKOFF_SECONDS.length - 1)];
        await db
          .update(jobs)
          .set({ status: "pending", lockedAt: null, lastError: message.slice(0, 500), runAt: new Date(Date.now() + delay * 1000) })
          .where(eq(jobs.id, j.id));
        console.warn(`[jobs] ${j.id} failed (attempt ${j.attempts}), retrying in ${delay}s: ${message}`);
      }
    }
  }
  return due.length;
}

// "Nobody has acknowledged this order": a NEW order that still sits in status "new" after `minutes` (default 5, env
// UNACK_ALERT_MINUTES) gets ONE reminder email to the restaurant's recipients (same opt-out as new-order emails) and
// an audit entry. Acknowledging = moving the order out of "new" on the board (start preparing / cancel).
export async function alertUnacknowledgedOrders(
  minutes = Number(process.env.UNACK_ALERT_MINUTES) || 5,
  onlyTenant?: string, // tests / manual runs; normally every restaurant is checked
): Promise<number> {
  const claimed = await db.execute<{ id: string; tenant_id: string; order_number: number; customer_name: string | null; created_at: string }>(sql`
    update orders set unack_alerted_at = now()
    where id in (
      select id from orders
      where status = 'new' and unack_alerted_at is null and created_at < now() - make_interval(mins => ${minutes})
        ${onlyTenant ? sql`and tenant_id = ${onlyTenant}` : sql``}
      for update skip locked
    ) and status = 'new'
    returning id, tenant_id, order_number, customer_name, created_at`);
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  let n = 0;
  for (const o of claimed) {
    const [settings] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, o.tenant_id));
    const [tenant] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, o.tenant_id));
    const waited = Math.max(minutes, Math.round((Date.now() - new Date(o.created_at).getTime()) / 60_000));
    await audit({
      action: "order.unacknowledged", actor: { type: "system", label: "job worker" }, tenantId: o.tenant_id,
      entityType: "order", entityId: o.id, summary: `Order #${o.order_number} still new after ${waited} minutes`,
      details: { orderNumber: o.order_number, minutes: waited },
    });
    n++;
    if (settings && !settings.notifyNewOrders) continue; // the restaurant turned order emails off (still audited)
    const to = await recipientsFor(o.tenant_id, settings?.notifyEmails ?? null);
    for (const addr of to) {
      await enqueueEmail(
        {
          to: addr, tenantId: o.tenant_id,
          subject: `Order #${o.order_number} NOT acknowledged – ${tenant?.name ?? ""}`,
          text: [
            `Order #${o.order_number}${o.customer_name ? ` (${o.customer_name})` : ""} came in ${waited} minutes ago and is still marked "new".`,
            "Nobody has started it or cancelled it on the orders board. Please check it now.",
            "",
            `Open the board: ${base}/dashboard/orders`,
          ].join("\n"),
        },
        { dedupeKey: `unack:${o.id}:${addr}` },
      );
    }
  }
  if (n) kickJobs();
  return n;
}

// Housekeeping: old counters and finished jobs. Keeps failed jobs (they are evidence) for 30 days.
export async function purgeOld() {
  await db.delete(rateLimit).where(lt(rateLimit.lastRequest, Date.now() - 24 * 3600_000));
  await db.delete(jobs).where(and(eq(jobs.status, "done"), lt(jobs.completedAt, new Date(Date.now() - 7 * 86400_000))));
  await db.delete(printJobs).where(lt(printJobs.createdAt, new Date(Date.now() - 30 * 86400_000))); // tickets + images: 30 days
  await db.delete(jobs).where(and(eq(jobs.status, "failed"), lt(jobs.createdAt, new Date(Date.now() - 30 * 86400_000))));
}

const g = globalThis as unknown as { __jobWorker?: boolean };

export type JobsHealth = {
  pending: number; // waiting (including those waiting for a retry)
  running: number;
  failed: number; // gave up (kept 30 days)
  due: number; // pending and already due: a healthy worker keeps this near zero
  oldestDueSeconds: number; // how long the longest-waiting due job has waited (0 = none): the worker lag
  lastDoneAt: Date | null;
};

// The state of the queue, for /admin/jobs and the worker health check. A dead worker shows up as a growing `oldestDueSeconds`.
export async function jobsHealth(): Promise<JobsHealth> {
  const [r] = await db.execute<{ pending: number; running: number; failed: number; due: number; oldest: number | null; last_done: string | null }>(sql`
    select
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'pending' and run_at <= now())::int as due,
      extract(epoch from now() - min(run_at) filter (where status = 'pending' and run_at <= now()))::float as oldest,
      max(completed_at) filter (where status = 'done') as last_done
    from jobs`);
  return {
    pending: r.pending, running: r.running, failed: r.failed, due: r.due,
    oldestDueSeconds: Math.max(0, Math.round(r.oldest ?? 0)),
    lastDoneAt: r.last_done ? new Date(r.last_done) : null,
  };
}

// Runs `batch` (which returns how many jobs it handled, at most `size`) until a batch comes back short: a burst of messages (many
// restaurants confirming orders at once) is cleared in one tick instead of 20 jobs per tick. `max` bounds a runaway loop.
export async function drainBatches(batch: () => Promise<number>, size = 20, max = 50): Promise<number> {
  let total = 0;
  for (let i = 0; i < max; i++) {
    const n = await batch();
    total += n;
    if (n < size) break;
  }
  return total;
}

const drain = () => drainBatches(() => processDueJobs());

// Starts the worker loop in THIS process (called once from instrumentation.ts). JOB_WORKER=off disables it (web containers when a
// dedicated worker runs); JOB_TICK_SECONDS sets the polling interval (default 5).
export function startJobWorker() {
  if (g.__jobWorker || !jobWorkerEnabled()) return;
  g.__jobWorker = true;
  const tickMs = Math.max(1, Number(process.env.JOB_TICK_SECONDS) || 5) * 1000;
  const perMinute = Math.max(1, Math.round(60_000 / tickMs));
  let tick = 0;
  let busy = false;
  const run = async () => {
    if (busy) return; // a slow tick is never overlapped by the next one
    busy = true;
    try {
      await drain();
      if (tick++ % perMinute === 0) {
        await alertUnacknowledgedOrders(); // about once a minute
        if (tick % (perMinute * 60) === 1) await purgeOld(); // about once an hour
      }
    } catch (e) {
      console.error("[jobs] worker tick failed", e);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, tickMs);
  timer.unref?.();
  console.log(`[jobs] worker started (${tickMs / 1000} s tick)`);
}

export { isNull }; // (kept for tests that build ad-hoc queries)
