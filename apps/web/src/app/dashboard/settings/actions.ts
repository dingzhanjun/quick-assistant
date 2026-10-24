"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { tenantSettings } from "@/db/schema";
import { validHours, validTimezone, type OpeningHours } from "@/lib/hours";
import { parseHumanLine } from "@/lib/human-line";
import { withTenant } from "@/lib/tenant-db";
import { parseEmails } from "@/lib/notify";
import { audit, changes, userActor } from "@/lib/audit";
import { FORBIDDEN, requireOwner } from "@/lib/roles";

export type ActionResult = { ok: true } | { ok: false; error: string };

// Phone numbers are attached by the platform admin only (/admin); restaurants see theirs read-only.

const emailSchema = z.string().email();

export async function saveNotifications(
  rawEmails: string,
  notifyNewOrders: boolean,
): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const emails = parseEmails(rawEmails);
  if (emails.length > 5) return { ok: false, error: "At most 5 email addresses" };
  const bad = emails.find((e) => !emailSchema.safeParse(e).success);
  if (bad) return { ok: false, error: `"${bad}" is not a valid email address` };

  const values = { notifyEmails: emails.join(", ") || null, notifyNewOrders };
  // Runs as THIS restaurant inside the database (row-level security); the platform-only columns are not writable.
  const prev = await withTenant(tenantId, async (db) => {
    const [prev] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    await db
      .insert(tenantSettings)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { ...values, updatedAt: new Date() } });
    return prev;
  });
  const diff = changes(prev ?? { notifyEmails: null, notifyNewOrders: true }, values);
  if (Object.keys(diff).length) {
    await audit({
      action: "settings.notifications_updated", actor: userActor(user), tenantId, entityType: "settings",
      summary: `Notification settings changed: ${Object.keys(diff).join(", ")}`, details: { changes: diff },
    });
  }
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true };
}

// Whether the phone agent offers to text the customer a link to their order (also needs SMS configured on the server).
export async function saveTextOrders(enabled: boolean): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (typeof enabled !== "boolean") return { ok: false, error: "Invalid input" };
  const values = { textOrderLink: enabled };
  const prev = await withTenant(tenantId, async (db) => {
    const [prev] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    await db
      .insert(tenantSettings)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { ...values, updatedAt: new Date() } });
    return prev;
  });
  if ((prev?.textOrderLink ?? true) !== enabled) {
    await audit({
      action: "settings.text_orders_updated", actor: userActor(user), tenantId, entityType: "settings",
      summary: `Texting order links to customers turned ${enabled ? "on" : "off"}`, details: { textOrderLink: enabled },
    });
  }
  revalidatePath("/dashboard/settings", "layout");
  return { ok: true };
}

export async function saveHours(timezone: string, hours: OpeningHours | null): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (!validTimezone(timezone)) return { ok: false, error: "Unknown time zone" };
  if (hours && !validHours(hours)) return { ok: false, error: "Invalid opening hours" };
  // Only the restaurant-controlled columns: `suspended` belongs to the platform admin.
  const values = { timezone, openingHours: hours };
  // Runs as THIS restaurant inside the database (row-level security); the platform-only columns are not writable.
  const prevHours = await withTenant(tenantId, async (db) => {
    const [prevHours] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    await db
      .insert(tenantSettings)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { ...values, updatedAt: new Date() } });
    return prevHours;
  });
  const hoursDiff = changes(prevHours ?? { timezone: "America/New_York", openingHours: null }, values);
  if (Object.keys(hoursDiff).length) {
    await audit({
      action: "settings.hours_updated", actor: userActor(user), tenantId, entityType: "settings",
      summary: hours ? "Opening hours changed" : "Opening hours removed (open 24/7)", details: { changes: hoursDiff },
    });
  }
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true };
}

export async function saveAddress(raw: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const address = raw.replace(/\s+/g, " ").trim();
  if (address.length > 300) return { ok: false, error: "Address is too long (300 characters at most)" };
  const value = address || null;
  // Only this column: suspended / transfer_number belong to the platform admin, notify_* and hours to other forms.
  const prev = await withTenant(tenantId, async (db) => {
    const [prev] = await db.select({ address: tenantSettings.address }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    await db
      .insert(tenantSettings)
      .values({ tenantId, address: value })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { address: value, updatedAt: new Date() } });
    return prev;
  });
  if ((prev?.address ?? null) !== value) {
    await audit({
      action: "settings.address_updated", actor: userActor(user), tenantId, entityType: "settings",
      summary: value ? "Restaurant address changed" : "Restaurant address removed", details: { from: prev?.address ?? null, to: value },
    });
  }
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true };
}

// The phone callers are forwarded to on keypad 0 / "human agent". Empty = off. (The agent's own phone numbers are
// set by the platform admin.)
export async function saveHumanLine(raw: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const parsed = await parseHumanLine(raw);
  if (!parsed.ok) return parsed;
  // Only this column: `suspended` is platform-controlled, the rest belong to other forms.
  const prev = await withTenant(tenantId, async (db) => {
    const [prev] = await db.select({ n: tenantSettings.transferNumber }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    await db
      .insert(tenantSettings)
      .values({ tenantId, transferNumber: parsed.e164 })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { transferNumber: parsed.e164, updatedAt: new Date() } });
    return prev;
  });
  if ((prev?.n ?? null) !== parsed.e164) {
    await audit({
      action: "settings.human_line_updated", actor: userActor(user), tenantId, entityType: "settings",
      summary: parsed.e164 ? `Human line set to ${parsed.e164}` : "Human line removed",
      details: { from: prev?.n ?? null, to: parsed.e164 },
    });
  }
  revalidatePath("/dashboard/settings", "layout"); // every settings tab
  return { ok: true };
}
