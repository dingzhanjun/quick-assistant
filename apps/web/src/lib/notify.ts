import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, organization, tenantSettings } from "@/db/schema";
import { formatPickup } from "./pickup";
import { lineUnitCents } from "./pricing";
import { enqueueEmail, kickJobs } from "./jobs";
import { recipientsFor } from "./recipients";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export { parseEmails } from "./recipients";

// Emails the restaurant about a new phone order. Never throws: a notification problem must
// not affect the order itself, so failures are only logged.
export async function notifyNewOrder(tenantId: string, orderId: string) {
  try {
    const [settings] = await db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    if (settings && !settings.notifyNewOrders) return;

    const order = await db.query.orders.findFirst({
      where: and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)),
      with: { items: true },
    });
    const [tenant] = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, tenantId));
    if (!order || !tenant) return;

    const to = await recipientsFor(tenantId, settings?.notifyEmails ?? null);
    if (!to.length) return;

    const total = order.items.reduce((s, i) => s + lineUnitCents(i.priceCents, i.modifiers) * i.quantity, 0);
    const lines = order.items.flatMap((i) => [
      `  ${i.quantity} x ${i.name}${i.notes ? ` (${i.notes})` : ""}`,
      ...i.modifiers.map(
        (m) => `      - ${m.group}: ${m.option}${m.priceDeltaCents ? ` (+${money(m.priceDeltaCents)})` : ""}`,
      ),
    ]);
    const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const text = [
      `New phone order #${order.orderNumber} for ${tenant.name}`,
      order.customerName ? `Customer: ${order.customerName}` : null,
      `Pickup: ${formatPickup(order.pickupAt, settings?.timezone ?? "America/New_York")}`,
      "",
      ...lines,
      "",
      `Total: ${money(total)}`,
      "",
      `Manage it: ${base}/dashboard/orders`,
    ]
      .filter((l) => l !== null)
      .join("\n");

    // Queued, not sent inline: a mail provider outage must not lose the notification (the worker retries).
    for (const addr of to) {
      await enqueueEmail({ to: addr, subject: `New order #${order.orderNumber} – ${tenant.name}`, text, tenantId }, { dedupeKey: `new:${order.id}:${addr}` });
    }
    kickJobs();
  } catch (e) {
    console.error("notifyNewOrder failed:", e);
  }
}

// Emails the restaurant that a CALLER cancelled an order, or replaced it with a new one (the kitchen must
// stop making the old one). Same recipients/opt-out as new-order emails. Never throws.
export async function notifyOrderCancelled(tenantId: string, orderNumber: number, replacedBy?: number) {
  try {
    const [settings] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    if (settings && !settings.notifyNewOrders) return;
    const [tenant] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, tenantId));
    if (!tenant) return;
    const to = await recipientsFor(tenantId, settings?.notifyEmails ?? null);
    if (!to.length) return;
    const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const subject = replacedBy
      ? `Order #${orderNumber} CHANGED, see #${replacedBy} – ${tenant.name}`
      : `Order #${orderNumber} CANCELLED – ${tenant.name}`;
    const text = [
      replacedBy
        ? `The customer changed order #${orderNumber} by phone. It is cancelled; the new order is #${replacedBy}.`
        : `The customer cancelled order #${orderNumber} by phone. Do not make it.`,
      "",
      `Manage it: ${base}/dashboard/orders`,
    ].join("\n");
    for (const addr of to) await enqueueEmail({ to: addr, subject, text, tenantId });
    kickJobs();
  } catch (e) {
    console.error("notifyOrderCancelled failed:", e);
  }
}
