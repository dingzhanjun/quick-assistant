"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { and, eq } from "drizzle-orm";
import { blockedNumbers, phoneNumbers, platformSettings, printAgents, tenantSettings } from "@/db/schema";
import { isAgentCommand, queueCommand } from "@/lib/print/service";
import { withTenant } from "@/lib/tenant-db";
import { parseHumanLine } from "@/lib/human-line";
import { normalizeE164 } from "@/lib/phone";
import { LLM_PROVIDERS, type LlmProvider } from "@/lib/llm-providers";
import { audit, maskPhone, userActor } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/admin";

export async function setTenantSuspended(tenantId: string, suspended: boolean) {
  const admin = await requirePlatformAdmin();
  await db
    .insert(tenantSettings)
    .values({ tenantId, suspended })
    .onConflictDoUpdate({
      target: tenantSettings.tenantId,
      set: { suspended, updatedAt: new Date() },
    });
  await audit({
    action: suspended ? "admin.tenant_suspended" : "admin.tenant_reactivated", actor: userActor(admin, "admin"),
    tenantId, entityType: "tenant", entityId: tenantId,
    summary: suspended ? "Restaurant suspended" : "Restaurant reactivated",
  });
  revalidatePath("/admin");
}

export async function setLlmConfig(
  provider: LlmProvider,
  model: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = await requirePlatformAdmin();
  model = model.trim();
  if (!(provider in LLM_PROVIDERS)) return { ok: false, error: "Unknown provider" };
  if (!/^[\w.:/-]{1,100}$/.test(model)) return { ok: false, error: "Invalid model name" };
  await db
    .insert(platformSettings)
    .values({ id: "default", llmProvider: provider, llmModel: model })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { llmProvider: provider, llmModel: model, updatedAt: new Date() },
    });
  await audit({
    action: "admin.llm_config_changed", actor: userActor(admin, "admin"), entityType: "platform_settings",
    summary: `LLM set to ${provider} / ${model}`, details: { provider, model },
  });
  revalidatePath("/admin");
  return { ok: true };
}

type Result = { ok: true } | { ok: false; error: string };
const BAD_NUMBER = "Use international format, e.g. +14155550123";

export async function addTenantNumber(tenantId: string, raw: string): Promise<Result> {
  const admin = await requirePlatformAdmin();
  const e164 = normalizeE164(raw);
  if (!e164) return { ok: false, error: BAD_NUMBER };
  // One agent number per restaurant: replace it by removing the old one first.
  const [current] = await db.select({ e164: phoneNumbers.e164 }).from(phoneNumbers).where(eq(phoneNumbers.tenantId, tenantId));
  if (current) return { ok: false, error: `This restaurant already has an agent number (${current.e164}). Remove it first to use another.` };
  // e164 is the primary key, so a number belongs to one restaurant only; the tenant index guards a concurrent add.
  let inserted: { e164: string }[] = [];
  try {
    inserted = await db.insert(phoneNumbers).values({ e164, tenantId }).onConflictDoNothing().returning({ e164: phoneNumbers.e164 });
  } catch {
    return { ok: false, error: "This restaurant already has an agent number" };
  }
  if (!inserted.length) return { ok: false, error: "That number is already in use" };
  await audit({
    action: "admin.phone_number_added", actor: userActor(admin, "admin"), tenantId, entityType: "phone_number",
    entityId: e164, summary: `Attached ${e164}`,
  });
  revalidatePath("/admin");
  return { ok: true };
}

export async function removeTenantNumber(tenantId: string, e164: string): Promise<Result> {
  const admin = await requirePlatformAdmin();
  const removed = await db
    .delete(phoneNumbers)
    .where(and(eq(phoneNumbers.e164, e164), eq(phoneNumbers.tenantId, tenantId)))
    .returning({ e164: phoneNumbers.e164 });
  if (removed.length) {
    await audit({
      action: "admin.phone_number_removed", actor: userActor(admin, "admin"), tenantId, entityType: "phone_number",
      entityId: e164, summary: `Removed ${e164}`,
    });
  }
  revalidatePath("/admin");
  return { ok: true };
}

export async function blockCaller(raw: string, reason: string): Promise<Result> {
  const admin = await requirePlatformAdmin();
  const e164 = normalizeE164(raw);
  if (!e164) return { ok: false, error: BAD_NUMBER };
  await db
    .insert(blockedNumbers)
    .values({ e164, reason: reason.trim().slice(0, 200) || null })
    .onConflictDoNothing();
  await audit({
    action: "admin.caller_blocked", actor: userActor(admin, "admin"), entityType: "caller", entityId: maskPhone(e164),
    summary: `Blocked caller ${maskPhone(e164)}`, details: { reason: reason.trim().slice(0, 200) || null },
  });
  revalidatePath("/admin");
  return { ok: true };
}

export async function unblockCaller(e164: string): Promise<Result> {
  const admin = await requirePlatformAdmin();
  await db.delete(blockedNumbers).where(eq(blockedNumbers.e164, e164));
  await audit({
    action: "admin.caller_unblocked", actor: userActor(admin, "admin"), entityType: "caller", entityId: maskPhone(e164),
    summary: `Unblocked caller ${maskPhone(e164)}`,
  });
  revalidatePath("/admin");
  return { ok: true };
}

// The human line callers are forwarded to on keypad 0 / "human agent". Empty = turn forwarding off.
// (Restaurant owners can set their own in Settings; this lets the platform admin set or fix it for them.)
export async function setTransferNumber(tenantId: string, raw: string): Promise<Result> {
  const admin = await requirePlatformAdmin();
  const parsed = await parseHumanLine(raw);
  if (!parsed.ok) return parsed;
  const e164 = parsed.e164;
  // Only this column: `suspended` is also platform-controlled but changed separately, notify_* belong to the restaurant.
  const [prev] = await db.select({ n: tenantSettings.transferNumber }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  await db
    .insert(tenantSettings)
    .values({ tenantId, transferNumber: e164 })
    .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { transferNumber: e164, updatedAt: new Date() } });
  if ((prev?.n ?? null) !== e164) {
    await audit({
      action: "admin.transfer_number_changed", actor: userActor(admin, "admin"), tenantId, entityType: "tenant", entityId: tenantId,
      summary: e164 ? `Human transfer number set to ${e164}` : "Human transfer number removed",
      details: { from: prev?.n ?? null, to: e164 },
    });
  }
  revalidatePath("/admin");
  return { ok: true };
}

// Service command for any restaurant's print agent (the technician's phone). Same allow-list and limits as the owner's.
export async function adminSendAgentCommand(agentId: string, command: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = await requirePlatformAdmin();
  if (!isAgentCommand(command) || !/^[0-9a-f-]{36}$/.test(agentId)) return { ok: false, error: "Unknown command" };
  const [agent] = await db.select({ tenantId: printAgents.tenantId }).from(printAgents).where(eq(printAgents.id, agentId));
  if (!agent) return { ok: false, error: "Unknown print agent" };
  const r = await withTenant(agent.tenantId, (tx) => queueCommand(tx, agent.tenantId, agentId, command, admin.email));
  if (!r.ok) return r;
  await audit({
    action: "print.command", actor: userActor(admin, "admin"), tenantId: agent.tenantId, entityType: "print_agent", entityId: agentId,
    summary: `Command "${command}" sent to a print agent by the platform admin`, details: { command },
  });
  revalidatePath("/admin/printing");
  return { ok: true };
}
