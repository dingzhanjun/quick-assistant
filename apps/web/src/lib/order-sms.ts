import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { orders, tenantSettings } from "@/db/schema";
import { AGENT, audit, maskPhone, type Actor } from "@/lib/audit";
import { enqueueSms, kickJobs } from "@/lib/jobs";
import { cancelSmsText, newOrderToken, orderLinkUrl, orderSmsText, pickupChangeSmsText } from "@/lib/order-link";
import { formatPickup } from "@/lib/pickup";
import { smsConfigured } from "@/lib/sms";
import { withTenant } from "@/lib/tenant-db";

// Texts the customer the link to their order, ONCE, if they gave a number during the call. It is triggered when the
// restaurant confirms the order (the first step out of "new": "Confirm & Print" / "Start preparing"), or straight away
// when the customer gives the number after that. Never throws: a failed text must not break confirming an order.
// Returns whether a text was queued.
export async function textOrderLink(tenantId: string, orderId: string, actor: Actor = AGENT): Promise<boolean> {
  try {
    if (!smsConfigured()) return false;
    const [settings] = await db.select({ on: tenantSettings.textOrderLink }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    if (settings && settings.on === false) return false; // the restaurant turned texting off
    // Claim it: only with a number, only once, never for a cancelled order (two clicks or two replicas cannot send twice).
    const [o] = await withTenant(tenantId, (tx) =>
      tx
        .update(orders)
        .set({ smsSentAt: new Date() })
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId), isNotNull(orders.contactNumber), isNull(orders.smsSentAt), ne(orders.status, "cancelled")))
        .returning({ number: orders.contactNumber, orderNumber: orders.orderNumber, token: orders.publicToken, count: orders.smsCount }),
    );
    if (!o?.number) return false;
    let token = o.token;
    if (!token) {
      token = newOrderToken(); // orders created before order links existed
      await withTenant(tenantId, (tx) => tx.update(orders).set({ publicToken: token }).where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId))));
    }
    await enqueueSms(
      { to: o.number, text: orderSmsText({ orderNumber: o.orderNumber, url: orderLinkUrl(token) }), tenantId, orderId },
      { dedupeKey: `sms-sent:${orderId}:${o.count}` }, // a corrected number (count 2) may send once more
    );
    kickJobs();
    await audit({
      action: "order.text_sent", actor, tenantId, entityType: "order", entityId: orderId,
      summary: `Order #${o.orderNumber}: the order link was texted to ${maskPhone(o.number)}`,
      details: { orderNumber: o.orderNumber, to: maskPhone(o.number) },
    });
    return true;
  } catch (e) {
    console.error("[sms] could not queue the order text", e);
    return false;
  }
}

// The restaurant moved the pickup time: text the customer the new time (and the link), if they gave a number during the call.
// Needs the same things as the order-link text (provider configured, restaurant allows texting). Never throws.
// Returns whether a text was queued. One text per distinct new time (a repeated save of the same time sends nothing).
export async function textPickupChange(tenantId: string, orderId: string, newPickup: Date, actor: Actor): Promise<boolean> {
  try {
    if (!smsConfigured()) return false;
    const [settings] = await db.select({ on: tenantSettings.textOrderLink, tz: tenantSettings.timezone }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    if (settings && settings.on === false) return false;
    const [o] = await withTenant(tenantId, (tx) =>
      tx
        .select({ number: orders.contactNumber, orderNumber: orders.orderNumber, token: orders.publicToken, status: orders.status })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId), isNotNull(orders.contactNumber), ne(orders.status, "cancelled"))),
    );
    if (!o?.number) return false;
    let token = o.token;
    if (!token) {
      token = newOrderToken();
      await withTenant(tenantId, (tx) => tx.update(orders).set({ publicToken: token }).where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId))));
    }
    const when = formatPickup(newPickup, settings?.tz ?? "America/New_York");
    const queued = await enqueueSms(
      { to: o.number, text: pickupChangeSmsText({ orderNumber: o.orderNumber, when, url: orderLinkUrl(token) }), tenantId, orderId },
      { dedupeKey: `sms-pickup:${orderId}:${newPickup.toISOString()}` },
    );
    if (!queued) return false;
    kickJobs();
    await audit({
      action: "order.text_sent", actor, tenantId, entityType: "order", entityId: orderId,
      summary: `Order #${o.orderNumber}: the customer was texted the new pickup time (${when}) at ${maskPhone(o.number)}`,
      details: { orderNumber: o.orderNumber, to: maskPhone(o.number), pickup: when },
    });
    return true;
  } catch (e) {
    console.error("[sms] could not queue the pickup-change text", e);
    return false;
  }
}

// The order was cancelled (by the restaurant on the board, or by the customer on the phone): text the customer, if they gave
// a number. Not used when a changed order replaces the old one (the customer just made the new one). Once per order. Never throws.
export async function textOrderCancelled(tenantId: string, orderId: string, actor: Actor): Promise<boolean> {
  try {
    if (!smsConfigured()) return false;
    const [settings] = await db.select({ on: tenantSettings.textOrderLink }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    if (settings && settings.on === false) return false;
    const [o] = await withTenant(tenantId, (tx) =>
      tx
        .select({ number: orders.contactNumber, orderNumber: orders.orderNumber, token: orders.publicToken, status: orders.status })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId), isNotNull(orders.contactNumber), eq(orders.status, "cancelled"))),
    );
    if (!o?.number) return false;
    let token = o.token;
    if (!token) {
      token = newOrderToken();
      await withTenant(tenantId, (tx) => tx.update(orders).set({ publicToken: token }).where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId))));
    }
    const queued = await enqueueSms(
      { to: o.number, text: cancelSmsText({ orderNumber: o.orderNumber, url: orderLinkUrl(token) }), tenantId, orderId },
      { dedupeKey: `sms-cancel:${orderId}` },
    );
    if (!queued) return false;
    kickJobs();
    await audit({
      action: "order.text_sent", actor, tenantId, entityType: "order", entityId: orderId,
      summary: `Order #${o.orderNumber}: the customer was texted that the order was cancelled (${maskPhone(o.number)})`,
      details: { orderNumber: o.orderNumber, to: maskPhone(o.number), cancelled: true },
    });
    return true;
  } catch (e) {
    console.error("[sms] could not queue the cancellation text", e);
    return false;
  }
}
