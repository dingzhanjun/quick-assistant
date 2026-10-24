"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { orders, tenantSettings } from "@/db/schema";
import { audit, userActor } from "@/lib/audit";
import { textOrderCancelled, textOrderLink, textPickupChange } from "@/lib/order-sms";
import { TIME_RE, effectivePickup, formatPickup, resolvePickup } from "@/lib/pickup";
import { enqueuePrint } from "@/lib/print/jobs";
import { withTenant } from "@/lib/tenant-db";
import { requireTenant } from "@/lib/tenant";

const status = z.enum(["new", "preparing", "ready", "completed", "cancelled"]);

export async function setOrderStatus(id: string, next: string): Promise<{ ok: boolean }> {
  const { tenantId, user } = await requireTenant();
  const parsed = status.safeParse(next);
  if (!parsed.success) return { ok: false };
  const { prev, updated } = await withTenant(tenantId, async (db) => {
    const [prev] = await db
      .select({ status: orders.status, orderNumber: orders.orderNumber })
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));
    const updated = await db
      .update(orders)
      .set({ status: parsed.data })
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .returning({ id: orders.id });
    return { prev, updated };
  });
  if (updated.length && prev && prev.status !== parsed.data) {
    const cancelled = parsed.data === "cancelled";
    await audit({
      action: cancelled ? "order.cancelled" : "order.updated", actor: userActor(user), tenantId,
      entityType: "order", entityId: id,
      summary: cancelled
        ? `Order #${prev.orderNumber} cancelled (was ${prev.status})`
        : `Order #${prev.orderNumber}: ${prev.status} -> ${parsed.data}`,
      details: { orderNumber: prev.orderNumber, from: prev.status, to: parsed.data },
    });
  }
  if (updated.length && prev && prev.status !== parsed.data) {
    if (parsed.data === "cancelled") {
      await enqueuePrint(tenantId, id, "cancelled");
      await textOrderCancelled(tenantId, id, userActor(user)); // tell the customer, if they gave a number on the call
    } else if (prev.status === "new") {
      // print_timing = on_accept: the ticket goes out when staff take the order (dedupe makes this a no-op otherwise)
      const [s] = await withTenant(tenantId, (db) => db.select({ t: tenantSettings.printTiming }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)));
      if (s?.t === "on_accept") await enqueuePrint(tenantId, id, "new");
    }
    // The restaurant took the order (Confirm & Print / Start preparing): tell the customer, if they gave a number on the call.
    if (prev.status === "new" && parsed.data !== "cancelled") await textOrderLink(tenantId, id, userActor(user));
  }
  revalidatePath("/dashboard/orders");
  return { ok: updated.length > 0 };
}

// "Reprint" on an order card: a fresh ticket marked REPRINT on every enabled printer. Any member may (staff work the board).
export async function reprintOrder(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { tenantId, user } = await requireTenant();
  const [o] = await withTenant(tenantId, (db) =>
    db.select({ orderNumber: orders.orderNumber }).from(orders).where(and(eq(orders.id, id), eq(orders.tenantId, tenantId))),
  );
  if (!o) return { ok: false, error: "Unknown order" };
  const n = await enqueuePrint(tenantId, id, "reprint");
  if (!n) return { ok: false, error: "No printer is set up (Settings → Kitchen printing)" };
  await audit({
    action: "print.reprint", actor: userActor(user), tenantId, entityType: "order", entityId: id,
    summary: `Order #${o.orderNumber} reprinted`, details: { orderNumber: o.orderNumber, printers: n },
  });
  return { ok: true };
}

// "Change Pickup Time" on an order card: the restaurant moves the pickup to `time` (24-hour HH:MM today in the restaurant's
// time zone), stored as `orders.new_pickup_at`, which then counts as the pickup time everywhere. The customer is texted the
// new time when they gave a number on the call. `time = null` puts the customer's original time back (no text). Any member
// of the restaurant may do it (like the other board buttons); only active orders can be changed.
export async function changePickupTime(
  id: string,
  time: string | null,
): Promise<{ ok: true; texted: boolean } | { ok: false; error: string }> {
  const { tenantId, user } = await requireTenant();
  if (time !== null && !TIME_RE.test(time)) return { ok: false, error: "Choose a valid time" };
  const loaded = await withTenant(tenantId, async (db) => {
    const [o] = await db.select().from(orders).where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));
    const [s] = await db.select({ tz: tenantSettings.timezone }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    return { o, tz: s?.tz ?? "America/New_York" };
  });
  const { o, tz } = loaded;
  if (!o) return { ok: false, error: "Unknown order" };
  if (o.status === "completed" || o.status === "cancelled") return { ok: false, error: "This order is already finished" };

  let next: Date | null = null;
  if (time !== null) {
    const r = resolvePickup(time, tz, null); // today, still ahead (opening hours are the restaurant's own call here)
    if (!r.ok) return { ok: false, error: "That time has already passed. Choose a later time today." };
    next = r.at;
  }
  const before = effectivePickup(o);
  const after = next ?? o.pickupAt;
  if ((before?.getTime() ?? null) === (after?.getTime() ?? null) && (o.newPickupAt?.getTime() ?? null) === (next?.getTime() ?? null)) {
    return { ok: true, texted: false }; // nothing changes
  }
  await withTenant(tenantId, (db) => db.update(orders).set({ newPickupAt: next }).where(and(eq(orders.id, id), eq(orders.tenantId, tenantId))));
  await audit({
    action: "order.pickup_changed", actor: userActor(user), tenantId, entityType: "order", entityId: id,
    summary: next
      ? `Order #${o.orderNumber}: pickup time changed from ${formatPickup(before, tz)} to ${formatPickup(next, tz)}`
      : `Order #${o.orderNumber}: pickup time set back to the original (${formatPickup(o.pickupAt, tz)})`,
    details: { orderNumber: o.orderNumber, from: before ? before.toISOString() : "asap", to: after ? after.toISOString() : "asap" },
  });
  const texted = next ? await textPickupChange(tenantId, id, next, userActor(user)) : false;
  revalidatePath("/dashboard/orders");
  return { ok: true, texted };
}
