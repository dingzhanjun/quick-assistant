import { desc, eq, inArray } from "drizzle-orm";
import { Suspense } from "react";
import { orders, printAgents, printers, printJobs, tenantSettings } from "@/db/schema";
import { isOnline } from "@/lib/print/agent";
import { printStateOf } from "@/lib/print/state";
import { effectivePickup, toLocalHHMM } from "@/lib/pickup";
import { requireTenant } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant-db";
import { OrdersBoard } from "./orders-board";

async function OrdersContent() {
  const { tenantId } = await requireTenant();
  // As THIS restaurant inside the database (row-level security), on top of the explicit filter.
  const { rows, jobs, hasPrinter, timing, tz } = await withTenant(tenantId, async (db) => {
    const rows = await db.query.orders.findMany({
      where: eq(orders.tenantId, tenantId),
      orderBy: desc(orders.createdAt),
      limit: 50,
      with: { items: true },
    });
    const jobs = rows.length
      ? await db
          .select({
            orderId: printJobs.orderId, status: printJobs.status, createdAt: printJobs.createdAt,
            printerEnabled: printers.enabled, agentRevokedAt: printAgents.revokedAt, agentLastSeenAt: printAgents.lastSeenAt,
          })
          .from(printJobs)
          .leftJoin(printers, eq(printers.id, printJobs.printerId))
          .leftJoin(printAgents, eq(printAgents.id, printers.agentId))
          .where(inArray(printJobs.orderId, rows.map((o) => o.id)))
          .orderBy(desc(printJobs.createdAt))
      : [];
    const hasPrinter = (await db.select({ id: printers.id }).from(printers).where(eq(printers.tenantId, tenantId)).limit(1)).length > 0;
    const [settings] = await db.select({ t: tenantSettings.printTiming, tz: tenantSettings.timezone }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    return { rows, jobs, hasPrinter, timing: settings?.t ?? "immediate", tz: settings?.tz ?? "America/New_York" };
  });
  // waiting / printed / failed (see lib/print/state.ts). null = this restaurant has no printer, so show nothing.
  const printState = (orderId: string) => {
    if (!hasPrinter) return null;
    const mine = jobs
      .filter((j) => j.orderId === orderId)
      .map((j) => {
        const deliverable = j.printerEnabled !== false && !j.agentRevokedAt;
        return { status: j.status, createdAt: j.createdAt, deliverable, online: deliverable && isOnline(j.agentLastSeenAt) };
      });
    return printStateOf(mine);
  };
  return (
    <OrdersBoard
      // the restaurant prints only after confirming: a new order's button reads "Confirm & Print"
      confirmToPrint={hasPrinter && timing === "on_accept"}
      orders={rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        contactNumber: o.smsCount > 0 ? o.contactNumber : null,
        publicToken: o.publicToken,
        smsSent: o.smsSentAt !== null,
        status: o.status,
        print: printState(o.id),
        createdAt: o.createdAt.toISOString(),
        pickupAt: effectivePickup(o) ? effectivePickup(o)!.toISOString() : null,
        // set when the restaurant moved the pickup: `originalPickup` is what the customer asked for (null = ASAP)
        pickupChanged: o.newPickupAt !== null,
        originalPickup: o.pickupAt ? o.pickupAt.toISOString() : null,
        pickupHHMM: effectivePickup(o) ? toLocalHHMM(effectivePickup(o)!, tz) : null, // prefills the change dialog (restaurant time zone)
        items: o.items.map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          priceCents: i.priceCents,
          modifiers: i.modifiers,
          notes: i.notes,
        })),
      }))}
    />
  );
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading orders…</p>}>
      <OrdersContent />
    </Suspense>
  );
}
