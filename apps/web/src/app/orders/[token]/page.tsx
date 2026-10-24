import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { db } from "@/db";
import { orderItems, orders, organization, tenantSettings } from "@/db/schema";
import { orderLinkExpired, validOrderToken } from "@/lib/order-link";
import { effectivePickup } from "@/lib/pickup";
import { lineUnitCents } from "@/lib/pricing";
import { formatClock } from "@/lib/print/ticket";
import { AutoRefresh } from "./auto-refresh";

// The page a customer is texted after ordering by phone. The unguessable token in the address is the only key:
// no sign-in, no phone numbers shown, not indexed by search engines.
export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false } };

// +14155550123 -> (415) 555-0123 (North America); anything else is shown as stored
const displayPhone = (e164: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const STATUS = {
  new: ["Received", "We have your order. The restaurant will start it shortly."],
  preparing: ["Being prepared", "The kitchen is making your order."],
  ready: ["Ready for pickup", "Your order is ready. Please come and pick it up."],
  completed: ["Picked up", "Thank you for your order!"],
  cancelled: ["Cancelled", "This order was cancelled. Please contact the restaurant if this is a surprise."],
} as const;

async function OrderView({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!validOrderToken(token)) notFound();
  // Platform code: the visitor has no session, so this reads through the plain connection by token only.
  const [order] = await db.select().from(orders).where(eq(orders.publicToken, token));
  if (!order) notFound();
  if (orderLinkExpired(order.createdAt)) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-xl font-semibold">This link has expired</h1>
        <p className="mt-2 text-muted-foreground">Order links stop working after a while. Please contact the restaurant.</p>
      </main>
    );
  }
  const [[tenant], [settings], items] = await Promise.all([
    db.select({ name: organization.name }).from(organization).where(eq(organization.id, order.tenantId)),
    db.select({ timezone: tenantSettings.timezone, address: tenantSettings.address, phone: tenantSettings.transferNumber }).from(tenantSettings).where(eq(tenantSettings.tenantId, order.tenantId)),
    db.select().from(orderItems).where(eq(orderItems.orderId, order.id)),
  ]);
  const tz = settings?.timezone ?? "America/New_York";
  const total = items.reduce((s, i) => s + lineUnitCents(i.priceCents, i.modifiers ?? []) * i.quantity, 0);
  const [label, hint] = STATUS[order.status];
  const done = order.status === "completed" || order.status === "cancelled";

  return (
    <main className="mx-auto w-full max-w-md space-y-5 p-6">
      {!done && <AutoRefresh seconds={15} />}
      <header>
        <p className="text-sm text-muted-foreground">{tenant?.name}</p>
        <h1 className="text-3xl font-bold">Order #{order.orderNumber}</h1>
        {order.customerName && <p className="text-muted-foreground">for {order.customerName}</p>}
      </header>

      <section aria-live="polite" className="rounded-lg border p-4">
        <p className="text-lg font-semibold">{label}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </section>

      <p className="text-lg">
        <span className="text-muted-foreground">Pickup: </span>
        <strong>{effectivePickup(order) ? formatClock(effectivePickup(order)!, tz) : "as soon as possible"}</strong>
        {order.newPickupAt && <span className="ml-2 text-sm text-muted-foreground">(updated by the restaurant)</span>}
      </p>

      <ul className="divide-y rounded-lg border">
        {items.map((i) => (
          <li key={i.id} className="flex justify-between gap-3 p-3">
            <div>
              <div className="font-medium">{i.quantity} × {i.name}</div>
              {(i.modifiers ?? []).map((m) => (
                <div key={m.option} className="text-sm text-muted-foreground">+ {m.option}</div>
              ))}
              {i.notes && <div className="text-sm text-muted-foreground">Note: {i.notes}</div>}
            </div>
            <div className="shrink-0">{money(lineUnitCents(i.priceCents, i.modifiers ?? []) * i.quantity)}</div>
          </li>
        ))}
        <li className="flex justify-between p-3 font-semibold">
          <span>Total</span>
          <span>{money(total)}</span>
        </li>
      </ul>

      {(settings?.address || settings?.phone) && (
        <section className="space-y-1 rounded-lg border p-4 text-sm">
          <h2 className="font-semibold">{tenant?.name}</h2>
          {settings.address && (
            <p>
              <span className="text-muted-foreground">Address: </span>
              <a className="underline" href={`https://maps.google.com/?q=${encodeURIComponent(settings.address)}`} target="_blank" rel="noreferrer">
                {settings.address}
              </a>
            </p>
          )}
          {settings.phone && (
            <p>
              <span className="text-muted-foreground">Questions about your order? Call: </span>
              <a className="underline" href={`tel:${settings.phone}`}>{displayPhone(settings.phone)}</a>
            </p>
          )}
        </section>
      )}
    </main>
  );
}

export default function OrderPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<p className="p-6 text-muted-foreground">Loading your order…</p>}>
      <OrderView params={params} />
    </Suspense>
  );
}
