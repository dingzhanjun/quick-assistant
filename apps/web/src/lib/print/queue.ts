import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { printAgentCommands, printers, printJobs } from "@/db/schema";
import { audit } from "../audit";
import { withTenant } from "../tenant-db";
import type { AuthedAgent } from "./agent";

export const LEASE_SECONDS = 60;
export const MAX_ATTEMPTS = 5;
export const COMMAND_TTL_MS = 5 * 60_000; // a command the agent does not collect within this long expires

export type Work =
  | { type: "job"; job: { id: string; kind: string; copies: number; device: string | null; printer: string } }
  | { type: "command"; command: { id: string; command: string; args: Record<string, unknown> | null } };

// Hands the agent its next piece of work, or null. Service commands first (a restart should not wait behind tickets),
// then the oldest ticket for one of ITS printers. A job is leased for 60 s (`FOR UPDATE SKIP LOCKED`, so concurrent
// polls never take the same one); if the agent dies the lease runs out and the ticket is handed out again
// (at-least-once; the agent remembers recent job ids and never prints one twice). After MAX_ATTEMPTS it is `failed`.
export async function claimWork(agent: AuthedAgent): Promise<Work | null> {
  const failed: { id: string; orderId: string | null }[] = [];
  const work = await withTenant(agent.tenantId, async (tx): Promise<Work | null> => {
    const now = new Date();
    await tx.update(printAgentCommands).set({ status: "expired", finishedAt: now })
      .where(and(eq(printAgentCommands.agentId, agent.id), eq(printAgentCommands.status, "queued"), lt(printAgentCommands.createdAt, new Date(now.getTime() - COMMAND_TTL_MS))));
    const [cmd] = await tx.select().from(printAgentCommands)
      .where(and(eq(printAgentCommands.agentId, agent.id), eq(printAgentCommands.status, "queued"), gt(printAgentCommands.createdAt, new Date(now.getTime() - COMMAND_TTL_MS))))
      .orderBy(printAgentCommands.createdAt).limit(1);
    if (cmd) {
      await tx.update(printAgentCommands).set({ status: "sent" }).where(eq(printAgentCommands.id, cmd.id));
      return { type: "command", command: { id: cmd.id, command: cmd.command, args: cmd.args } };
    }

    // Jobs whose lease ran out too many times are given up on, then the next claimable one is leased.
    const dead = await tx.execute<{ id: string; order_id: string | null }>(sql`
      update print_jobs j set status = 'failed', error = coalesce(j.error, 'the printer agent did not confirm printing')
      from printers p
      where p.id = j.printer_id and p.agent_id = ${agent.id} and j.status = 'leased' and j.leased_until < now() and j.attempts >= ${MAX_ATTEMPTS}
      returning j.id, j.order_id`);
    for (const d of dead) failed.push({ id: d.id, orderId: d.order_id });

    const rows = await tx.execute<{ id: string; kind: string; copies: number; device_key: string | null; printer: string }>(sql`
      with next as (
        select j.id from print_jobs j join printers p on p.id = j.printer_id
        where p.agent_id = ${agent.id} and p.enabled
          and (j.status = 'pending' or (j.status = 'leased' and j.leased_until < now()))
        order by j.created_at limit 1 for update of j skip locked)
      update print_jobs j set status = 'leased', attempts = j.attempts + 1, leased_until = now() + make_interval(secs => ${LEASE_SECONDS})
      from next, printers p
      where j.id = next.id and p.id = j.printer_id
      returning j.id, j.kind, p.copies, p.device_key, p.name as printer`);
    const row = [...rows][0];
    return row ? { type: "job", job: { id: row.id, kind: row.kind, copies: row.copies, device: row.device_key, printer: row.printer } } : null;
  });
  for (const f of failed) await auditFailed(agent.tenantId, f.id, f.orderId, "the printer agent did not confirm printing");
  return work;
}

export async function auditFailed(tenantId: string, jobId: string, orderId: string | null, error: string) {
  await audit({
    action: "print.job_failed", actor: { type: "system", label: "print agent" }, tenantId, entityType: "print_job", entityId: jobId,
    summary: `A ticket could not be printed: ${error}`.slice(0, 300), details: { orderId, error },
  });
}

// The agent reports the outcome of a leased job. A failure goes back to `pending` (retried) until MAX_ATTEMPTS.
export async function finishJob(agent: AuthedAgent, jobId: string, ok: boolean, error?: string): Promise<"ok" | "not_found"> {
  let gaveUp: { orderId: string | null } | null = null;
  const res = await withTenant(agent.tenantId, async (tx) => {
    const [job] = await tx
      .select({ id: printJobs.id, attempts: printJobs.attempts, orderId: printJobs.orderId })
      .from(printJobs).innerJoin(printers, eq(printers.id, printJobs.printerId))
      .where(and(eq(printJobs.id, jobId), eq(printers.agentId, agent.id), inArray(printJobs.status, ["leased", "pending"])));
    if (!job) return "not_found" as const;
    if (ok) await tx.update(printJobs).set({ status: "done", printedAt: new Date(), error: null, leasedUntil: null }).where(eq(printJobs.id, jobId));
    else if (job.attempts >= MAX_ATTEMPTS) {
      await tx.update(printJobs).set({ status: "failed", error: error ?? "print failed", leasedUntil: null }).where(eq(printJobs.id, jobId));
      gaveUp = { orderId: job.orderId };
    } else await tx.update(printJobs).set({ status: "pending", error: error ?? "print failed", leasedUntil: null }).where(eq(printJobs.id, jobId));
    return "ok" as const;
  });
  if (gaveUp) await auditFailed(agent.tenantId, jobId, (gaveUp as { orderId: string | null }).orderId, error ?? "print failed");
  return res;
}
