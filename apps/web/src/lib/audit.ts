import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import type { AuditAction } from "./audit-actions";

export type Actor = {
  type: "user" | "admin" | "agent" | "system";
  id?: string | null;
  label?: string | null;
};

export const AGENT: Actor = { type: "agent", label: "voice agent" };
export const userActor = (u: { id: string; email: string }, type: "user" | "admin" = "user"): Actor => ({
  type,
  id: u.id,
  label: u.email,
});

// Fields that changed between two snapshots, as { field: [before, after] }. Empty object = nothing changed.
export function changes<T extends Record<string, unknown>>(before: T, after: Partial<T>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) out[k] = [before[k] ?? null, after[k] ?? null];
  }
  return out;
}

// Records one action. NEVER throws: failing to write the log must not break the action being logged
// (it is reported on the server console instead). Pass only what is safe to keep: no passwords or tokens.
export async function audit(e: {
  action: AuditAction;
  actor: Actor;
  tenantId?: string | null;
  entityType?: string;
  entityId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      tenantId: e.tenantId ?? null,
      actorType: e.actor.type,
      actorId: e.actor.id ?? null,
      actorLabel: e.actor.label ?? null,
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      summary: e.summary.slice(0, 500),
      details: e.details ?? null,
    });
  } catch (err) {
    console.error("[audit] could not write", e.action, err);
  }
}

// Caller numbers are kept only masked in the trail (the audit log is not covered by the 90-day purge).
export const maskPhone = (n: string | null | undefined) => {
  const d = (n ?? "").replace(/\D/g, "");
  return d.length > 4 ? `***${d.slice(-4)}` : n ? "***" : null;
};
