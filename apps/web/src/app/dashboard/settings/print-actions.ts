"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { printAgents, printers, printJobs, tenantSettings } from "@/db/schema";
import { audit, changes, userActor } from "@/lib/audit";
import { hashCode, newPairingCode, PAIRING_LONG_DAYS, PAIRING_MINUTES } from "@/lib/print/agent";
import { buildFirstBootFiles, validateFirstBoot, type FirstBootInput } from "@/lib/print/firstboot";
import { enqueueTestPrint } from "@/lib/print/jobs";
import { agentRelease } from "@/lib/print/release";
import { isAgentCommand, queueCommand } from "@/lib/print/service";
import { FORBIDDEN, requireOwner } from "@/lib/roles";
import { withTenant } from "@/lib/tenant-db";
import { validTimezone } from "@/lib/hours";
import type { ActionResult } from "./actions";

const uuid = z.string().uuid();

export async function savePrintSettings(timing: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (timing !== "immediate" && timing !== "on_accept") return { ok: false, error: "Unknown print timing" };
  const values = { printTiming: timing } as const;
  const prev = await withTenant(tenantId, async (db) => {
    const [prev] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    await db.insert(tenantSettings).values({ tenantId, ...values })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { ...values, updatedAt: new Date() } });
    return prev;
  });
  const diff = changes(prev ?? { printTiming: "immediate" }, values);
  if (Object.keys(diff).length) {
    await audit({
      action: "print.settings_updated", actor: userActor(user), tenantId, entityType: "settings",
      summary: `Printing settings changed: ${Object.keys(diff).join(", ")}`, details: { changes: diff },
    });
  }
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true };
}

// Creates an agent row with a one-time pairing code (shown once, stored hashed, valid 15 minutes).
export async function createPrintAgent(name: string): Promise<{ ok: true; code: string; minutes: number } | { ok: false; error: string }> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const n = name.trim().slice(0, 60);
  if (!n) return { ok: false, error: "Give the print agent a name, e.g. Kitchen" };
  const code = newPairingCode();
  const id = await withTenant(tenantId, async (db) => {
    const [row] = await db.insert(printAgents)
      .values({ tenantId, name: n, pairingCodeHash: hashCode(code), pairingExpiresAt: new Date(Date.now() + PAIRING_MINUTES * 60_000) })
      .returning({ id: printAgents.id });
    return row.id;
  });
  await audit({
    action: "print.agent_pairing_started", actor: userActor(user), tenantId, entityType: "print_agent", entityId: id,
    summary: `Print agent "${n}" added; waiting for it to pair`,
  });
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true, code, minutes: PAIRING_MINUTES };
}

// Fresh pairing code for an agent that has not paired yet (code lost or expired) or that needs re-pairing.
export async function newPairingCodeFor(agentId: string): Promise<{ ok: true; code: string; minutes: number } | { ok: false; error: string }> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (!uuid.safeParse(agentId).success) return { ok: false, error: "Unknown print agent" };
  const code = newPairingCode();
  const done = await withTenant(tenantId, (db) =>
    db.update(printAgents)
      .set({ pairingCodeHash: hashCode(code), pairingExpiresAt: new Date(Date.now() + PAIRING_MINUTES * 60_000) })
      .where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, tenantId)))
      .returning({ id: printAgents.id, name: printAgents.name }),
  );
  if (!done.length) return { ok: false, error: "Unknown print agent" };
  await audit({
    action: "print.agent_pairing_started", actor: userActor(user), tenantId, entityType: "print_agent", entityId: agentId,
    summary: `New pairing code for print agent "${done[0].name}"`,
  });
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true, code, minutes: PAIRING_MINUTES };
}

export async function revokePrintAgent(agentId: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (!uuid.safeParse(agentId).success) return { ok: false, error: "Unknown print agent" };
  const done = await withTenant(tenantId, (db) =>
    db.update(printAgents)
      .set({ revokedAt: new Date(), tokenHash: null, pairingCodeHash: null, pairingExpiresAt: null })
      .where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, tenantId)))
      .returning({ name: printAgents.name }),
  );
  if (!done.length) return { ok: false, error: "Unknown print agent" };
  // Tickets still waiting for this agent will never be collected: give them up now instead of leaving orders on "Printing…".
  await withTenant(tenantId, (db) =>
    db
      .update(printJobs)
      .set({ status: "failed", error: "the print agent was revoked", leasedUntil: null })
      .where(and(
        inArray(printJobs.status, ["pending", "leased"]),
        inArray(printJobs.printerId, db.select({ id: printers.id }).from(printers).where(and(eq(printers.agentId, agentId), eq(printers.tenantId, tenantId)))),
      )),
  );
  await audit({
    action: "print.agent_revoked", actor: userActor(user), tenantId, entityType: "print_agent", entityId: agentId,
    summary: `Print agent "${done[0].name}" revoked`,
  });
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true };
}

// Deletes a print agent that is finished with: revoked, or never paired. Its printers and their ticket history go with it
// (an orphaned printer would keep collecting tickets nobody prints). An active agent has to be revoked first.
export async function deletePrintAgent(agentId: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (!uuid.safeParse(agentId).success) return { ok: false, error: "Unknown print agent" };
  const r = await withTenant(tenantId, async (db) => {
    const [a] = await db
      .select({ name: printAgents.name, revokedAt: printAgents.revokedAt, lastSeenAt: printAgents.lastSeenAt })
      .from(printAgents)
      .where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, tenantId)));
    if (!a) return { ok: false as const, error: "Unknown print agent" };
    if (!a.revokedAt && a.lastSeenAt) return { ok: false as const, error: "Revoke the agent first" };
    const gone = await db.delete(printers).where(and(eq(printers.agentId, agentId), eq(printers.tenantId, tenantId))).returning({ id: printers.id });
    await db.delete(printAgents).where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, tenantId)));
    return { ok: true as const, name: a.name, printers: gone.length };
  });
  if (!r.ok) return r;
  await audit({
    action: "print.agent_deleted", actor: userActor(user), tenantId, entityType: "print_agent", entityId: agentId,
    summary: `Print agent "${r.name}" deleted (${r.printers} printer(s) removed with it)`,
  });
  revalidatePath("/dashboard/settings", "layout");
  return { ok: true };
}

const printerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]),
  copies: z.number().int().min(1).max(3),
  enabled: z.boolean(),
});

export async function updatePrinter(id: string, input: z.input<typeof printerSchema>): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const parsed = printerSchema.safeParse(input);
  if (!parsed.success || !uuid.safeParse(id).success) return { ok: false, error: "Invalid printer settings" };
  const values = parsed.data;
  const prev = await withTenant(tenantId, async (db) => {
    const [prev] = await db.select().from(printers).where(and(eq(printers.id, id), eq(printers.tenantId, tenantId)));
    if (prev) await db.update(printers).set(values).where(and(eq(printers.id, id), eq(printers.tenantId, tenantId)));
    return prev;
  });
  if (!prev) return { ok: false, error: "Unknown printer" };
  const diff = changes(prev, values);
  if (Object.keys(diff).length) {
    await audit({
      action: "print.printer_updated", actor: userActor(user), tenantId, entityType: "printer", entityId: id,
      summary: `Printer "${prev.name}" changed: ${Object.keys(diff).join(", ")}`, details: { changes: diff },
    });
  }
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true };
}

export async function removePrinter(id: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (!uuid.safeParse(id).success) return { ok: false, error: "Unknown printer" };
  const gone = await withTenant(tenantId, (db) =>
    db.delete(printers).where(and(eq(printers.id, id), eq(printers.tenantId, tenantId))).returning({ name: printers.name }),
  );
  if (!gone.length) return { ok: false, error: "Unknown printer" };
  await audit({
    action: "print.printer_removed", actor: userActor(user), tenantId, entityType: "printer", entityId: id,
    summary: `Printer "${gone[0].name}" removed`,
  });
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true };
}

export async function testPrint(printerId: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (!uuid.safeParse(printerId).success) return { ok: false, error: "Unknown printer" };
  if (!(await enqueueTestPrint(tenantId, printerId))) return { ok: false, error: "Unknown printer" };
  await audit({
    action: "print.test", actor: userActor(user), tenantId, entityType: "printer", entityId: printerId, summary: "Test ticket sent",
  });
  return { ok: true };
}

export async function sendAgentCommand(agentId: string, command: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (!uuid.safeParse(agentId).success || !isAgentCommand(command)) return { ok: false, error: "Unknown command" };
  const r = await withTenant(tenantId, (tx) => queueCommand(tx, tenantId, agentId, command, user.email));
  if (!r.ok) return r;
  await audit({
    action: "print.command", actor: userActor(user), tenantId, entityType: "print_agent", entityId: agentId,
    summary: `Command "${command}" sent to a print agent`, details: { command },
  });
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true };
}

// "Set up a Pi without a monitor": creates the agent with a pairing code that stays valid for 7 days and returns the files
// to copy onto the SD card's boot partition (cloud-init user-data, and network-config for Wi-Fi). The Wi-Fi password only
// passes through here (HTTPS) to be turned into a key; it is not stored or logged.
export async function createSetupFiles(input: {
  name: string; hostname: string; ssid?: string; wifiPassword?: string; country?: string; sshKey?: string;
}): Promise<{ ok: true; files: { name: string; content: string }[]; days: number } | { ok: false; error: string }> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const release = agentRelease();
  const base = release?.baseUrl;
  const server = process.env.BETTER_AUTH_URL?.replace(/\/+$/, "");
  if (!base || !server) return { ok: false, error: "This server has no print-agent files to install from (they are built into the web image)." };
  const name = input.name.trim().slice(0, 60);
  if (!name) return { ok: false, error: "Give the print agent a name, e.g. Kitchen" };

  const [settings] = await withTenant(tenantId, (db) => db.select({ tz: tenantSettings.timezone }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)));
  const timezone = settings?.tz && validTimezone(settings.tz) ? settings.tz : "America/New_York";
  const code = newPairingCode();
  const fb: FirstBootInput = {
    hostname: input.hostname.trim().toLowerCase(), timezone, code, server, base,
    ...(input.ssid ? { wifi: { ssid: input.ssid, password: input.wifiPassword ?? "", country: (input.country ?? "").trim().toUpperCase() } } : {}),
    ...(input.sshKey?.trim() ? { sshKey: input.sshKey.trim() } : {}),
  };
  const bad = validateFirstBoot(fb);
  if (bad) return { ok: false, error: bad };
  const { userData, networkConfig } = buildFirstBootFiles(fb);

  const id = await withTenant(tenantId, async (db) => {
    const [row] = await db.insert(printAgents)
      .values({ tenantId, name, pairingCodeHash: hashCode(code), pairingExpiresAt: new Date(Date.now() + PAIRING_LONG_DAYS * 86_400_000) })
      .returning({ id: printAgents.id });
    return row.id;
  });
  await audit({
    action: "print.agent_pairing_started", actor: userActor(user), tenantId, entityType: "print_agent", entityId: id,
    summary: `Print agent "${name}" added with SD-card setup files (code valid ${PAIRING_LONG_DAYS} days)`,
    details: { hostname: fb.hostname, wifi: !!fb.wifi, sshKey: !!fb.sshKey },
  });
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true, days: PAIRING_LONG_DAYS, files: [{ name: "user-data", content: userData }, ...(networkConfig ? [{ name: "network-config", content: networkConfig }] : [])] };
}
