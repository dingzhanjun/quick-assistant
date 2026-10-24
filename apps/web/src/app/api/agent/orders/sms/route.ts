import { and, eq, gt, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { orders, tenantSettings } from "@/db/schema";
import { AGENT, audit, maskPhone } from "@/lib/audit";
import { isAgentRequest } from "@/lib/agent-auth";
import { resolveAgentTenant } from "@/lib/agent-tenant";
import { newOrderToken, parseTextNumber } from "@/lib/order-link";
import { textOrderLink } from "@/lib/order-sms";
import { smsConfigured } from "@/lib/sms";
import { withTenant } from "@/lib/tenant-db";

const body = z.object({
  to: z.string(),
  order_number: z.number().int().min(1).max(10_000_000),
  // The number to text: what the caller SAID, or their own caller id. Normalised and checked here.
  number: z.string().min(7).max(40),
});

// An order may be texted for a short while after it was placed (the call itself lasts at most a few minutes), at most
// twice (one correction of the number), and one destination number receives at most 3 order texts per day from ALL
// restaurants: a caller must not be able to make us spam someone else's phone.
const FRESH_MINUTES = 30;
const MAX_TEXTS_PER_ORDER = 2;
const MAX_TEXTS_PER_NUMBER_PER_DAY = 3;

export async function POST(req: Request) {
  if (!isAgentRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const t = await resolveAgentTenant(parsed.data.to);
  if ("response" in t) return t.response;
  const tenantId = t.tenantId;

  const [settings] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  if (!smsConfigured() || settings?.textOrderLink === false) return NextResponse.json({ ok: false, reason: "sms_off" });

  const number = parseTextNumber(parsed.data.number);
  if (!number) return NextResponse.json({ ok: false, reason: "bad_number" });

  const result = await withTenant(tenantId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}))`);
    const [order] = await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.orderNumber, parsed.data.order_number)));
    if (!order || order.status === "cancelled") return { ok: false, reason: "no_order" } as const;
    if (order.createdAt.getTime() < Date.now() - FRESH_MINUTES * 60_000) return { ok: false, reason: "too_old" } as const;
    if (order.contactNumber === number && order.smsCount > 0) return { ok: true, duplicate: true, order } as const; // same request again
    if (order.smsCount >= MAX_TEXTS_PER_ORDER) return { ok: false, reason: "order_limit" } as const;
    return { ok: true, duplicate: false, order } as const;
  });
  if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason });
  if (result.duplicate) return NextResponse.json({ ok: true, duplicate: true });
  const order = result.order;

  // Platform-wide count for this destination (the restaurant role cannot see other restaurants, so `db`).
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.contactNumber, number), gt(orders.createdAt, new Date(Date.now() - 86_400_000)), ne(orders.smsCount, 0), ne(orders.id, order.id)));
  if (n >= MAX_TEXTS_PER_NUMBER_PER_DAY) return NextResponse.json({ ok: false, reason: "number_limit" });

  // Remember the number. The text itself goes out when the restaurant confirms the order (see textOrderLink); a corrected
  // number clears "sent" so the right phone gets it too.
  const token = order.publicToken ?? newOrderToken();
  await withTenant(tenantId, (tx) =>
    tx
      .update(orders)
      .set({ contactNumber: number, publicToken: token, smsCount: sql`${orders.smsCount} + 1`, smsSentAt: null })
      .where(and(eq(orders.id, order.id), eq(orders.tenantId, tenantId))),
  );
  await audit({
    action: "order.text_requested", actor: AGENT, tenantId, entityType: "order", entityId: order.id,
    summary: `Order #${order.orderNumber}: the customer asked for the order link by text to ${maskPhone(number)} (sent when the restaurant confirms)`,
    details: { orderNumber: order.orderNumber, to: maskPhone(number), attempt: order.smsCount + 1 },
  });
  // Already confirmed while the customer was still on the line: nothing left to wait for.
  if (order.status !== "new") await textOrderLink(tenantId, order.id);
  return NextResponse.json({ ok: true });
}
