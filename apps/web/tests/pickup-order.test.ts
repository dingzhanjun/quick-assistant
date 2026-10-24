// Pickup time on phone orders: validated against the clock and the opening hours, stored, handed back on lookup.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

process.env.AGENT_API_KEY = "test-agent-key";
mock.module("next/server", { namedExports: { NextResponse, after: () => {} } });

const run = randomUUID().slice(0, 8);
const T = `pick-${run}`;
const NUM = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
const CALLER = "+15550003333";
let db: typeof import("../src/db")["db"];
let S: typeof import("../src/db/schema");
let dish: { id: string };

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  await db.insert(S.organization).values({ id: T, name: T, slug: T, createdAt: new Date() });
  await db.insert(S.phoneNumbers).values({ e164: NUM, tenantId: T });
  await db.insert(S.tenantSettings).values({ tenantId: T, timezone: "UTC" });
  [dish] = await db.insert(S.menuItems).values({ tenantId: T, name: "Soup", priceCents: 500 }).returning();
});
after(async () => {
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  await db.delete(S.organization).where(eq(S.organization.id, T));
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, NUM));
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
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const order = (pickup?: unknown) =>
  call("orders", { to: NUM, caller: CALLER, items: [{ item_id: dish.id, quantity: 1 }], ...(pickup ? { pickup } : {}) });
const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
const pickupOf = async (n: number) =>
  (await db.select().from(S.orders).where(eq(S.orders.orderNumber, n)).then((r) => r.find((o) => o.tenantId === T)))!.pickupAt;

test("asap (the default) is stored as no time", async () => {
  const a = await order({ type: "asap" });
  const b = await order(); // older agents send nothing: still asap
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(await pickupOf(a.json.order_number as number), null);
});

test("a time today is stored in the restaurant's time zone; the past and out-of-range input are refused", async () => {
  const now = new Date();
  if (now.getUTCHours() < 22) {
    const later = hhmm(new Date(now.getTime() + 60 * 60_000));
    const r = await order({ type: "time", time: later });
    assert.equal(r.status, 200);
    const at = await pickupOf(r.json.order_number as number);
    assert.equal(hhmm(at!), later);
  }
  if (now.getUTCHours() >= 3) {
    const past = await order({ type: "time", time: hhmm(new Date(now.getTime() - 3 * 3600_000)) });
    assert.deepEqual([past.status, past.json.error], [422, "pickup_in_past"]);
  }
  for (const bad of ["25:00", "7:30", "noon", ""]) assert.equal((await order({ type: "time", time: bad })).status, 400, bad);
});

test("a time outside the restaurant's opening hours is refused with the hours", async () => {
  // open only on a weekday that is not today
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const other = days[(new Date().getUTCDay() + 3) % 7];
  await db.update(S.tenantSettings).set({ openingHours: { [other]: [["09:00", "23:00"]] } }).where(eq(S.tenantSettings.tenantId, T));
  try {
    const now = new Date();
    if (now.getUTCHours() < 22) {
      const r = await order({ type: "time", time: hhmm(new Date(now.getTime() + 30 * 60_000)) });
      assert.deepEqual([r.status, r.json.error], [422, "pickup_closed"]);
      assert.match(String(r.json.hours), /9 AM to 11 PM/);
    }
  } finally {
    await db.update(S.tenantSettings).set({ openingHours: null }).where(eq(S.tenantSettings.tenantId, T));
  }
});

test("lookup hands the pickup back so a changed order keeps it", async () => {
  const now = new Date();
  if (now.getUTCHours() >= 22) return;
  const later = hhmm(new Date(now.getTime() + 60 * 60_000));
  const placed = await order({ type: "time", time: later });
  const look = await call("orders/lookup", { to: NUM, order_number: placed.json.order_number, caller: CALLER });
  assert.equal((look.json.order as { pickup: string }).pickup, later);
  const asap = await order({ type: "asap" });
  const look2 = await call("orders/lookup", { to: NUM, order_number: asap.json.order_number, caller: CALLER });
  assert.equal((look2.json.order as { pickup: string }).pickup, "asap");
});
