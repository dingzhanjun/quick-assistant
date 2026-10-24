import { and, eq, inArray, sql } from "drizzle-orm";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { menuItems, orderItems, orders, phoneNumbers, tenantSettings } from "@/db/schema";
import { AGENT, audit, maskPhone } from "@/lib/audit";
import { isAgentRequest } from "@/lib/agent-auth";
import { groupsForItems, resolveSelection, type ModifierSnapshot } from "@/lib/modifiers";
import { lineUnitCents } from "@/lib/pricing";
import { checkChangeable } from "@/lib/order-changes";
import { TIME_RE, resolvePickup } from "@/lib/pickup";
import { notifyNewOrder, notifyOrderCancelled } from "@/lib/notify";
import { newOrderToken } from "@/lib/order-link";
import { enqueuePrint } from "@/lib/print/jobs";
import { phoneCandidates } from "@/lib/phone";
import { withTenant } from "@/lib/tenant-db";

const body = z.object({
  to: z.string(),
  customer_name: z.string().max(200).optional(),
  caller: z.string().max(100).optional(),
  // Call id + cart hash from the agent; resubmitting the same key returns the same order.
  idempotency_key: z.string().min(1).max(200).optional(),
  // Change-my-order: this still-"new" order from the same caller is cancelled in the same transaction.
  replaces_order_number: z.number().int().min(1).max(10_000_000).optional(),
  // When the customer picks it up: as soon as possible, or a time today (24-hour HH:MM, restaurant's time zone).
  pickup: z
    .union([z.object({ type: z.literal("asap") }), z.object({ type: z.literal("time"), time: z.string().regex(TIME_RE) })])
    .default({ type: "asap" }),
  items: z
    .array(
      z.object({
        item_id: z.string().uuid(),
        quantity: z.number().int().min(1).max(99),
        notes: z.string().max(500).optional(),
        // Ids of chosen modifier options (from the menu the agent was given); validated below.
        option_ids: z.array(z.string().uuid()).max(30).default([]),
      }),
    )
    .min(1),
});

export async function POST(req: Request) {
  if (!isAgentRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { to, customer_name, items, idempotency_key, replaces_order_number, pickup } = parsed.data;
  const caller = parsed.data.caller ? (phoneCandidates(parsed.data.caller)[0] ?? null) : null;

  const candidates = phoneCandidates(to);
  const [number] = await db
    .select()
    .from(phoneNumbers)
    .where(inArray(phoneNumbers.e164, candidates.length ? candidates : ["-"]));
  if (!number) return NextResponse.json({ error: "unknown number" }, { status: 404 });
  const tenantId = number.tenantId;

  const [settings] = await db
    .select({ suspended: tenantSettings.suspended, timezone: tenantSettings.timezone, openingHours: tenantSettings.openingHours, printTiming: tenantSettings.printTiming })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  if (settings?.suspended) return NextResponse.json({ error: "suspended" }, { status: 403 });

  if (idempotency_key) {
    const [dup] = await withTenant(tenantId, (db) =>
      db
        .select({ orderNumber: orders.orderNumber })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.idempotencyKey, idempotency_key))),
    );
    if (dup) return NextResponse.json({ order_number: dup.orderNumber, duplicate: true });
  }

  // Pickup time: validated against the clock and the opening hours of THIS restaurant, never trusted from the agent.
  let pickupAt: Date | null = null;
  if (pickup.type === "time") {
    const r = resolvePickup(pickup.time, settings?.timezone ?? "America/New_York", settings?.openingHours ?? null);
    if (!r.ok) {
      return NextResponse.json({ error: r.code === "past" ? "pickup_in_past" : "pickup_closed", hours: r.hours ?? null }, { status: 422 });
    }
    pickupAt = r.at;
  }

  // Everything that reads or writes this restaurant's data runs as THIS restaurant inside the database (row-level
  // security), on top of the explicit tenant filters. Early refusals are returned as a Response.
  let replacedId: string | null = null;
  const phase = await withTenant(tenantId, async (db) => {
    // Price/name come from the DB, scoped to this tenant, never from the agent.
    const menu = await db
      .select()
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, tenantId),
          eq(menuItems.available, true),
          inArray(menuItems.id, [...new Set(items.map((i) => i.item_id))]),
        ),
      );
    const byId = new Map(menu.map((m) => [m.id, m]));
    const unknown = items.filter((i) => !byId.has(i.item_id));
    if (unknown.length) {
      return NextResponse.json(
        { error: "unknown or unavailable items", item_ids: unknown.map((i) => i.item_id) },
        { status: 422 },
      );
    }

    // Validate every line's modifier choices against the groups attached to that exact item.
    const groupsByItem = await groupsForItems(tenantId, [...byId.keys()]);
    const snapshots: ModifierSnapshot[][] = [];
    for (const [idx, line] of items.entries()) {
      const picked = resolveSelection(groupsByItem.get(line.item_id) ?? [], line.option_ids);
      if (!picked.ok) {
        return NextResponse.json(
          { error: `invalid choices for "${byId.get(line.item_id)!.name}": ${picked.error}`, line: idx },
          { status: 422 },
        );
      }
      snapshots.push(picked.snapshot);
    }

    const result = await db.transaction(async (tx) => {
      // Serialize number allocation per tenant.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}))`);
      if (idempotency_key) {
        // Re-check under the lock: a concurrent retry may have created it since the check above.
        const [dup] = await tx
          .select()
          .from(orders)
          .where(and(eq(orders.tenantId, tenantId), eq(orders.idempotencyKey, idempotency_key)));
        if (dup) return { order: dup, duplicate: true };
      }
      if (replaces_order_number) {
        const check = await checkChangeable(tx, tenantId, replaces_order_number, caller);
        if (!check.ok) return { conflict: check.reason } as const;
        const [cancelled] = await tx
          .update(orders)
          .set({ status: "cancelled" })
          .where(and(eq(orders.id, check.order.id), eq(orders.status, "new")))
          .returning({ id: orders.id });
        if (!cancelled) return { conflict: "not_new" } as const;
        replacedId = check.order.id;
      }
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${orders.orderNumber}), 0) + 1` })
        .from(orders)
        .where(eq(orders.tenantId, tenantId));
      const [created] = await tx
        .insert(orders)
        .values({
          tenantId,
          orderNumber: next,
          customerName: customer_name,
          callerNumber: caller,
          publicToken: newOrderToken(),
          pickupAt,
          idempotencyKey: idempotency_key,
        })
        .returning();
      await tx.insert(orderItems).values(
        items.map((i, idx) => {
          const m = byId.get(i.item_id)!;
          return {
            orderId: created.id,
            menuItemId: m.id,
            name: m.name,
            priceCents: m.priceCents,
            modifiers: snapshots[idx],
            quantity: i.quantity,
            notes: i.notes,
          };
        }),
      );
      return { order: created, duplicate: false };
    });

    return { byId, snapshots, result };
  });
  if (phase instanceof Response) return phase;
  const { byId, snapshots, result } = phase;

  if ("conflict" in result) {
    return NextResponse.json({ error: "cannot_replace", reason: result.conflict }, { status: 409 });
  }
  if (result.duplicate) return NextResponse.json({ order_number: result.order.orderNumber, duplicate: true });
  const order = result.order;

  const total = items.reduce(
    (sum, line, idx) =>
      sum + lineUnitCents(byId.get(line.item_id)!.priceCents, snapshots[idx]) * line.quantity,
    0,
  );
  // Runs after the response is sent so the caller isn't kept waiting on email.
  after(async () => {
    await audit({
      action: "order.created", actor: AGENT, tenantId, entityType: "order", entityId: order.id,
      summary: `Order #${order.orderNumber} created by the phone agent: ${items.length} line(s), $${(total / 100).toFixed(2)}`,
      details: {
        orderNumber: order.orderNumber, customerName: customer_name ?? null, caller: maskPhone(caller),
        totalCents: total,
        pickup: pickupAt ? pickupAt.toISOString() : "asap",
        ...(replaces_order_number ? { replacesOrderNumber: replaces_order_number } : {}),
        lines: items.map((l, idx) => ({ name: byId.get(l.item_id)!.name, quantity: l.quantity, notes: l.notes ?? null, options: snapshots[idx].map((m) => m.option) })),
      },
    });
    if (replaces_order_number && replacedId) {
      await audit({
        action: "order.cancelled", actor: AGENT, tenantId, entityType: "order", entityId: replacedId,
        summary: `Order #${replaces_order_number} cancelled: customer changed it (new order #${order.orderNumber})`,
        details: { orderNumber: replaces_order_number, from: "new", to: "cancelled", replacedBy: order.orderNumber, byCaller: maskPhone(caller) },
      });
      await notifyOrderCancelled(tenantId, replaces_order_number, order.orderNumber);
    }
    await notifyNewOrder(tenantId, order.id);
    // Kitchen ticket: at once, or (print_timing = on_accept) when staff accept the order on the board. A change also
    // sends a CANCELLED ticket for the order it replaces when that one had been printed.
    if (settings?.printTiming !== "on_accept") {
      if (replaces_order_number && replacedId) await enqueuePrint(tenantId, replacedId, "cancelled");
      await enqueuePrint(tenantId, order.id, replaces_order_number ? "changed" : "new", { replaces: replaces_order_number });
    }
  });

  return NextResponse.json({ order_number: order.orderNumber, ...(replaces_order_number ? { replaced: replaces_order_number } : {}) });
}
