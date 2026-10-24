import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { phoneCandidates } from "./phone";

type Tx = Pick<typeof db, "select">;
export type Order = typeof orders.$inferSelect;

// Why a caller may not cancel/change an order. `no_match` deliberately covers both "no such order number"
// and "that order was not placed from this phone number", so the phone line cannot be used to probe which
// order numbers exist. `not_new` is only ever reported to the caller who owns the order.
export type RefusalReason = "no_caller" | "no_match" | "not_new";
export type ChangeCheck = { ok: true; order: Order } | { ok: false; reason: RefusalReason };

export const normalizeCaller = (raw: string | null | undefined) => (raw ? (phoneCandidates(raw)[0] ?? null) : null);

// LAUNCH_PLAN rule: a caller can cancel or change an order only while it is still "new" AND only from the
// phone number that placed it (a withheld number can never do it).
export async function checkChangeable(
  tx: Tx,
  tenantId: string,
  orderNumber: number,
  callerRaw: string | null | undefined,
): Promise<ChangeCheck> {
  const caller = normalizeCaller(callerRaw);
  if (!caller) return { ok: false, reason: "no_caller" };
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.orderNumber, orderNumber)));
  if (!order || order.callerNumber !== caller) return { ok: false, reason: "no_match" };
  if (order.status !== "new") return { ok: false, reason: "not_new" };
  return { ok: true, order };
}
