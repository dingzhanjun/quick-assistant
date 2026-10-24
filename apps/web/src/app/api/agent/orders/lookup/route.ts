import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { orderItems, tenantSettings } from "@/db/schema";
import { AGENT, audit, maskPhone } from "@/lib/audit";
import { isAgentRequest } from "@/lib/agent-auth";
import { resolveAgentTenant } from "@/lib/agent-tenant";
import { checkChangeable } from "@/lib/order-changes";
import { lineUnitCents } from "@/lib/pricing";
import { withTenant } from "@/lib/tenant-db";
import { effectivePickup, toLocalHHMM } from "@/lib/pickup";

const body = z.object({ to: z.string(), order_number: z.number().int().min(1).max(10_000_000), caller: z.string().max(100).optional() });

// "Can this caller cancel or change order N?" If yes, returns the order so the agent can read it back.
export async function POST(req: Request) {
  if (!isAgentRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const t = await resolveAgentTenant(parsed.data.to);
  if ("response" in t) return t.response;

  // As THIS restaurant inside the database (row-level security).
  const check = await withTenant(t.tenantId, (db) => checkChangeable(db, t.tenantId, parsed.data.order_number, parsed.data.caller));
  if (!check.ok) {
    if (check.reason !== "not_new") {
      await audit({
        action: "order.cancel_refused", actor: AGENT, tenantId: t.tenantId, entityType: "order",
        summary: `Lookup of order #${parsed.data.order_number} refused (${check.reason}) from ${maskPhone(parsed.data.caller) ?? "withheld number"}`,
        details: { reason: check.reason, orderNumber: parsed.data.order_number, caller: maskPhone(parsed.data.caller) },
      });
    }
    return NextResponse.json({ allowed: false, reason: check.reason });
  }

  const { cfg, items } = await withTenant(t.tenantId, async (db) => {
    const [cfg] = await db.select({ timezone: tenantSettings.timezone }).from(tenantSettings).where(eq(tenantSettings.tenantId, t.tenantId));
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, check.order.id));
    return { cfg, items };
  });
  const tz = cfg?.timezone ?? "America/New_York";
  const total = items.reduce((s, i) => s + lineUnitCents(i.priceCents, i.modifiers) * i.quantity, 0);
  // A change rebuilds the cart from these lines, so every line needs its dish and option ids.
  const canChange = items.every((i) => i.menuItemId && i.modifiers.every((m) => m.optionId));
  return NextResponse.json({
    allowed: true,
    order: {
      order_number: check.order.orderNumber,
      customer_name: check.order.customerName,
      total_cents: total,
      can_change: canChange,
      // "asap" or the local HH:MM it was due; the agent reloads it when the order is changed
      pickup: effectivePickup(check.order) ? toLocalHHMM(effectivePickup(check.order)!, tz) : "asap", // the restaurant's new time counts
      items: items.map((i) => ({
        item_id: i.menuItemId,
        name: i.name,
        quantity: i.quantity,
        notes: i.notes ?? "",
        option_ids: i.modifiers.flatMap((m) => (m.optionId ? [m.optionId] : [])),
        options: i.modifiers.map((m) => m.option),
        line_cents: lineUnitCents(i.priceCents, i.modifiers) * i.quantity,
      })),
    },
  });
}
