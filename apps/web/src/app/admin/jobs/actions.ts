"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { requirePlatformAdmin } from "@/lib/admin";
import { audit, maskPhone, userActor } from "@/lib/audit";

type Result = { ok: true; count: number } | { ok: false; error: string };

const who = (j: { type: string; payload: { to: string } }) => (j.type === "sms" ? maskPhone(j.payload.to) : j.payload.to);
const kind = (t: string) => (t === "sms" ? "text" : "email");

// Puts a failed (or waiting) job back in the queue to run NOW with a fresh set of attempts.
export async function retryJob(id: string): Promise<Result> {
  const admin = await requirePlatformAdmin();
  const [j] = await db
    .update(jobs)
    .set({ status: "pending", attempts: 0, runAt: new Date(), lockedAt: null, lastError: null, completedAt: null })
    .where(and(eq(jobs.id, id), inArray(jobs.status, ["failed", "pending"])))
    .returning();
  if (!j) return { ok: false, error: "That job is no longer failed or waiting" };
  await audit({
    action: "admin.job_retried", actor: userActor(admin, "admin"), tenantId: j.payload.tenantId ?? null, entityType: "job", entityId: id,
    summary: `A ${kind(j.type)} to ${who(j)} was put back in the queue`,
  });
  revalidatePath("/admin/jobs");
  return { ok: true, count: 1 };
}

// Retries every failed job (of one type, or all). Capped so one click cannot flood a provider.
export async function retryFailedJobs(type: "email" | "sms" | null): Promise<Result> {
  const admin = await requirePlatformAdmin();
  const rows = await db.execute<{ id: string }>(sql`
    update jobs set status = 'pending', attempts = 0, run_at = now(), locked_at = null, last_error = null, completed_at = null
    where id in (select id from jobs where status = 'failed' ${type ? sql`and type = ${type}` : sql``} order by created_at limit 200)
    returning id`);
  const count = [...rows].length;
  if (count) {
    await audit({
      action: "admin.job_retried", actor: userActor(admin, "admin"), entityType: "job",
      summary: `${count} failed ${type ? kind(type) : "email/text"} job(s) were put back in the queue`, details: { count, type },
    });
  }
  revalidatePath("/admin/jobs");
  return { ok: true, count };
}

// Throws away a failed or waiting job (for example a text to a number that can never work).
export async function deleteJob(id: string): Promise<Result> {
  const admin = await requirePlatformAdmin();
  const [j] = await db.delete(jobs).where(and(eq(jobs.id, id), inArray(jobs.status, ["failed", "pending"]))).returning();
  if (!j) return { ok: false, error: "That job is no longer failed or waiting" };
  await audit({
    action: "admin.job_deleted", actor: userActor(admin, "admin"), tenantId: j.payload.tenantId ?? null, entityType: "job", entityId: id,
    summary: `A ${kind(j.type)} to ${who(j)} (${j.status}) was deleted from the queue`,
    details: { status: j.status, attempts: j.attempts, error: j.lastError },
  });
  revalidatePath("/admin/jobs");
  return { ok: true, count: 1 };
}
