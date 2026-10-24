import { and, eq, sql } from "drizzle-orm";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { orders } from "@/db/schema";
import { AGENT, audit, maskPhone } from "@/lib/audit";
import { isAgentRequest } from "@/lib/agent-auth";
import { resolveAgentTenant } from "@/lib/agent-tenant";
import { notifyOrderCancelled } from "@/lib/notify";
import { textOrderCancelled } from "@/lib/order-sms";
import { enqueuePrint } from "@/lib/print/jobs";
import { checkChangeable } from "@/lib/order-changes";
import { withTenant } from "@/lib/tenant-db";

const body = z.object({ to: z.string(), order_number: z.number().int().min(1).max(10_000_000), caller: z.string().max(100).optional() });

// Cancels an order at the caller's request. Same rule as lookup, re-checked under a lock and again in the
// UPDATE itself (status must still be "new"), so it cannot race with the kitchen starting the order.
export async function POST(req: Request) {
  if (!isAgentRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const t = await resolveAgentTenant(parsed.data.to);
  if ("response" in t) return t.response;
  const { order_number, caller } = parsed.data;

  // As THIS restaurant inside the database (row-level security).
  const result = await withTenant(t.tenantId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${t.tenantId}))`);
    const check = await checkChangeable(tx, t.tenantId, order_number, caller);
    if (!check.ok) return check;
    const [done] = await tx
      .update(orders)
      .set({ status: "cancelled" })
      .where(and(eq(orders.id, check.order.id), eq(orders.status, "new")))
      .returning({ id: orders.id });
    return done ? ({ ok: true, order: check.order } as const) : ({ ok: false, reason: "not_new" } as const);
  });

  if (!result.ok) {
    if (result.reason !== "not_new") {
      await audit({
        action: "order.cancel_refused", actor: AGENT, tenantId: t.tenantId, entityType: "order",
        summary: `Cancel of order #${order_number} refused (${result.reason}) from ${maskPhone(caller) ?? "withheld number"}`,
        details: { reason: result.reason, orderNumber: order_number, caller: maskPhone(caller) },
      });
    }
    return NextResponse.json({ cancelled: false, reason: result.reason });
  }

  after(async () => {
    await audit({
      action: "order.cancelled", actor: AGENT, tenantId: t.tenantId, entityType: "order", entityId: result.order.id,
      summary: `Order #${order_number} cancelled by the customer on the phone`,
      details: { orderNumber: order_number, from: "new", to: "cancelled", byCaller: maskPhone(caller) },
    });
    await notifyOrderCancelled(t.tenantId, order_number);
    await enqueuePrint(t.tenantId, result.order.id, "cancelled");
    await textOrderCancelled(t.tenantId, result.order.id, AGENT); // the customer cancelled by phone: confirm it by text if they gave a number
  });
  return NextResponse.json({ cancelled: true, order_number });
}
