// Callers cancelling / changing their order by phone: only from the same number, only while the order is "new".
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

process.env.AGENT_API_KEY = "test-agent-key";
const deferred: (() => Promise<void> | void)[] = [];
mock.module("next/server", { namedExports: { NextResponse, after: (fn: () => Promise<void> | void) => void deferred.push(fn) } });

const run = randomUUID().slice(0, 8);
const A = `chg-a-${run}`, B = `chg-b-${run}`;
const rnd = () => `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
const NUM_A = rnd(), NUM_B = rnd();
const ME = "+15550001111", OTHER = "+15550002222";
let db: typeof import("../src/db")["db"];
let S: typeof import("../src/db/schema");
let dish: { id: string }, opt: { id: string }, dishB: { id: string };

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  for (const id of [A, B]) await db.insert(S.organization).values({ id, name: id, slug: id, createdAt: new Date() });
  await db.insert(S.phoneNumbers).values([{ e164: NUM_A, tenantId: A }, { e164: NUM_B, tenantId: B }]);
  [dish] = await db.insert(S.menuItems).values({ tenantId: A, name: "Pizza", priceCents: 1000 }).returning();
  [dishB] = await db.insert(S.menuItems).values({ tenantId: B, name: "Other", priceCents: 500 }).returning();
  const [g] = await db.insert(S.modifierGroups).values({ tenantId: A, name: "Crust", required: true, maxSelect: 1 }).returning();
  [opt] = await db.insert(S.modifierOptions).values({ tenantId: A, groupId: g.id, name: "Thin", priceDeltaCents: 100 }).returning();
  await db.insert(S.menuItemModifierGroups).values({ menuItemId: dish.id, groupId: g.id, sortOrder: 0 });
});
after(async () => {
  for (const id of [A, B]) await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, id));
  for (const id of [A, B]) await db.delete(S.organization).where(eq(S.organization.id, id));
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, NUM_A));
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, NUM_B));
  process.exit(0);
});

async function call(route: string, payload: unknown) {
  const mod = await import(`../src/app/api/agent/${route}/route`);
  const res: Response = await mod.POST(
    new Request(`http://t/api/agent/${route}`, {
      method: "POST",
      headers: { authorization: "Bearer test-agent-key", "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  for (const fn of deferred.splice(0)) await fn();
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { order_number: number; reason?: string; allowed?: boolean; cancelled?: boolean; replaced?: number; duplicate?: boolean; order: { total_cents: number; can_change: boolean; items: { option_ids: string[] }[] } } };
}
const place = (extra: Record<string, unknown> = {}) =>
  call("orders", { to: NUM_A, caller: ME, customer_name: "Pat", items: [{ item_id: dish.id, quantity: 2, option_ids: [opt.id] }], ...extra });
const statusOf = async (n: number) => (await db.select().from(S.orders).where(and(eq(S.orders.tenantId, A), eq(S.orders.orderNumber, n))))[0].status;

test("lookup: only the caller who placed a NEW order can see it, and nobody learns which numbers exist", async () => {
  const n = (await place()).json.order_number;
  const ok = await call("orders/lookup", { to: NUM_A, order_number: n, caller: ME });
  assert.equal(ok.json.allowed, true);
  assert.deepEqual(
    [ok.json.order.total_cents, ok.json.order.can_change, ok.json.order.items[0].option_ids],
    [2200, true, [opt.id]],
  );
  const wrongCaller = await call("orders/lookup", { to: NUM_A, order_number: n, caller: OTHER });
  const noSuchOrder = await call("orders/lookup", { to: NUM_A, order_number: 99999, caller: ME });
  assert.deepEqual([wrongCaller.json.reason, noSuchOrder.json.reason], ["no_match", "no_match"]); // indistinguishable
  assert.equal((await call("orders/lookup", { to: NUM_A, order_number: n })).json.reason, "no_caller"); // withheld number
  // another restaurant's number cannot reach it either
  assert.equal((await call("orders/lookup", { to: NUM_B, order_number: n, caller: ME })).json.reason, "no_match");
  assert.ok((await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, A), eq(S.auditLogs.action, "order.cancel_refused")))).length >= 2);
});

test("cancel: works once, for the right caller, while new; the kitchen is told", async () => {
  const n = (await place()).json.order_number;
  assert.equal((await call("orders/cancel", { to: NUM_A, order_number: n, caller: OTHER })).json.cancelled, false);
  assert.equal(await statusOf(n), "new");
  assert.equal((await call("orders/cancel", { to: NUM_A, order_number: n, caller: ME })).json.cancelled, true);
  assert.equal(await statusOf(n), "cancelled");
  const second = await call("orders/cancel", { to: NUM_A, order_number: n, caller: ME });
  assert.deepEqual([second.json.cancelled, second.json.reason], [false, "not_new"]);
  const [entry] = await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, A), eq(S.auditLogs.action, "order.cancelled"), eq(S.auditLogs.actorType, "agent")));
  assert.match(entry.summary, new RegExp(`#${n} cancelled by the customer`));
});

test("an order the kitchen has started can no longer be cancelled or changed by phone", async () => {
  const n = (await place()).json.order_number;
  await db.update(S.orders).set({ status: "preparing" }).where(and(eq(S.orders.tenantId, A), eq(S.orders.orderNumber, n)));
  assert.equal((await call("orders/lookup", { to: NUM_A, order_number: n, caller: ME })).json.reason, "not_new");
  assert.equal((await call("orders/cancel", { to: NUM_A, order_number: n, caller: ME })).json.reason, "not_new");
  const rep = await place({ replaces_order_number: n });
  assert.deepEqual([rep.status, rep.json.reason], [409, "not_new"]);
  assert.equal(await statusOf(n), "preparing");
});

test("change: the new order replaces the old one atomically", async () => {
  const old = (await place()).json.order_number;
  const bad = await place({ replaces_order_number: old, caller: OTHER });
  assert.equal(bad.status, 409);
  assert.equal(await statusOf(old), "new"); // a refused change leaves the old order untouched
  const orders = await db.select().from(S.orders).where(eq(S.orders.tenantId, A));
  const before = orders.length;

  const key = `chg-${run}`;
  const changed = await place({ replaces_order_number: old, idempotency_key: key });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.replaced, old);
  assert.equal(await statusOf(old), "cancelled");
  assert.equal(await statusOf(changed.json.order_number), "new");
  const retry = await place({ replaces_order_number: old, idempotency_key: key }); // network retry
  assert.deepEqual([retry.json.order_number, retry.json.duplicate], [changed.json.order_number, true]);
  assert.equal((await db.select().from(S.orders).where(eq(S.orders.tenantId, A))).length, before + 1);
  const logs = await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, A), eq(S.auditLogs.action, "order.cancelled")));
  assert.ok(logs.some((l) => (l.details as { replacedBy?: number }).replacedBy === changed.json.order_number));
});

test("another restaurant's order number cannot be replaced from this restaurant's line", async () => {
  const other = await call("orders", { to: NUM_B, caller: ME, items: [{ item_id: dishB.id, quantity: 1 }] });
  const res = await place({ replaces_order_number: other.json.order_number });
  // A has its own order with that number or none; either way B's order must not be touched
  assert.ok(res.status === 409 || res.status === 200);
  const [b] = await db.select().from(S.orders).where(and(eq(S.orders.tenantId, B), eq(S.orders.orderNumber, other.json.order_number)));
  assert.equal(b.status, "new");
});
