// "Change Pickup Time": the restaurant moves an order's pickup; it becomes the pickup time everywhere and the customer is texted.
// Needs a migrated Postgres (DATABASE_URL); creates a throwaway restaurant and removes it afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { effectivePickup, formatPickup, localTimeToday, toLocalHHMM } from "../src/lib/pickup";
import { buildTicket } from "../src/lib/print/ticket";

const T = `pc-${randomUUID().slice(0, 8)}`;
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/tenant.ts"), {
  namedExports: { requireTenant: async () => ({ tenantId: T, role: "member", user: { id: "u", email: "u@x" } }) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
process.env.SMS_PROVIDER = "log";

// A time zone where it is about 10:00 right now, so "now + 90 minutes" is always still today (the action only accepts today).
const tz = (() => {
  for (let k = -12; k <= 12; k++) {
    const zone = `Etc/GMT${k >= 0 ? "+" : "-"}${Math.abs(k)}`;
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    if (h >= 9 && h <= 11) return zone;
  }
  return "UTC";
})();
const at = (minutesFromNow: number) => toLocalHHMM(new Date(Date.now() + minutesFromNow * 60_000), tz);

type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");
let actions: typeof import("../src/app/dashboard/orders/actions");

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  actions = await import("../src/app/dashboard/orders/actions");
  await db.insert(S.organization).values({ id: T, name: "Pickup test", slug: T, createdAt: new Date() });
  await db.insert(S.tenantSettings).values({ tenantId: T, timezone: tz });
});
after(async () => {
  await db.delete(S.jobs).where(sql`${S.jobs.payload}->>'tenantId' = ${T}`);
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  await db.delete(S.organization).where(eq(S.organization.id, T));
  process.exit(0);
});

const mkOrder = async (n: number, extra: Partial<typeof S.orders.$inferInsert> = {}) =>
  (await db.insert(S.orders).values({ tenantId: T, orderNumber: n, customerName: "Pat", publicToken: randomUUID().replace(/-/g, "").slice(0, 22), ...extra }).returning())[0];
const get = async (id: string) => (await db.select().from(S.orders).where(eq(S.orders.id, id)))[0];
const texts = async (orderId: string) => (await db.select().from(S.jobs).where(eq(S.jobs.type, "sms"))).filter((j) => j.payload.orderId === orderId);

test("the new pickup time is stored, counts as the pickup time, and the customer is texted once per distinct time", async () => {
  const o = await mkOrder(1, { contactNumber: "+14045550144", smsCount: 1, publicToken: "B".repeat(22) }); // asked for ASAP, gave a number
  const t1 = at(90);
  assert.deepEqual(await actions.changePickupTime(o.id, t1), { ok: true, texted: true });
  const row = await get(o.id);
  assert.equal(row.pickupAt, null, "what the customer asked for is kept");
  assert.equal(row.newPickupAt?.getTime(), localTimeToday(t1, tz, new Date()).getTime());
  assert.equal(effectivePickup(row)?.getTime(), row.newPickupAt?.getTime(), "the new time is the pickup time");

  const sent = await texts(o.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.to, "+14045550144");
  assert.equal(sent[0].payload.text, `Your pickup time for order #1 is now ${formatPickup(row.newPickupAt, tz)}. Details: ${(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "")}/orders/${"B".repeat(22)}`);

  // saving the same time again changes nothing and sends nothing; another time sends another text
  assert.deepEqual(await actions.changePickupTime(o.id, t1), { ok: true, texted: false });
  assert.equal((await texts(o.id)).length, 1);
  assert.equal((await actions.changePickupTime(o.id, at(120)) as { texted: boolean }).texted, true);
  assert.equal((await texts(o.id)).length, 2);

  // back to the original: no text, the field is cleared
  assert.deepEqual(await actions.changePickupTime(o.id, null), { ok: true, texted: false });
  assert.equal((await get(o.id)).newPickupAt, null);
  assert.equal((await texts(o.id)).length, 2);

  const audits = await db.select().from(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  assert.equal(audits.filter((a) => a.action === "order.pickup_changed").length, 3);
  assert.ok(audits.every((a) => !JSON.stringify(a).includes("5550144")), "the number is masked in the audit trail");
});

test("no number, no text; a past time, a bad time and a finished order are refused", async () => {
  const noNumber = await mkOrder(2);
  assert.deepEqual(await actions.changePickupTime(noNumber.id, at(90)), { ok: true, texted: false });
  assert.ok((await get(noNumber.id)).newPickupAt, "the time still changes");
  assert.equal((await texts(noNumber.id)).length, 0);

  assert.equal((await actions.changePickupTime(noNumber.id, at(-90))).ok, false, "a time that has passed");
  assert.equal((await actions.changePickupTime(noNumber.id, "25:99")).ok, false);
  assert.equal((await actions.changePickupTime(noNumber.id, "6pm")).ok, false);
  assert.equal((await actions.changePickupTime(randomUUID(), at(90))).ok, false, "unknown order");

  const done = await mkOrder(3, { status: "completed" });
  assert.equal((await actions.changePickupTime(done.id, at(90))).ok, false);
  const cancelled = await mkOrder(4, { status: "cancelled" });
  assert.equal((await actions.changePickupTime(cancelled.id, at(90))).ok, false);

  // the restaurant switched texting off: the time changes, no text
  const off = await mkOrder(5, { contactNumber: "+14045550155", smsCount: 1 });
  await db.update(S.tenantSettings).set({ textOrderLink: false }).where(eq(S.tenantSettings.tenantId, T));
  assert.deepEqual(await actions.changePickupTime(off.id, at(90)), { ok: true, texted: false });
  await db.update(S.tenantSettings).set({ textOrderLink: true }).where(eq(S.tenantSettings.tenantId, T));
});

test("the kitchen ticket shows the new pickup time", () => {
  const base = { orderNumber: 1, customerName: "Pat", createdAt: new Date(), items: [] };
  const original = new Date("2026-10-22T22:00:00Z");
  const moved = new Date("2026-10-22T23:30:00Z");
  const common = { kind: "new" as const, restaurant: "R", timezone: "UTC" };
  assert.equal(buildTicket({ ...common, order: { ...base, pickupAt: original } }).pickup, "10:00 PM");
  assert.equal(buildTicket({ ...common, order: { ...base, pickupAt: original, newPickupAt: moved } }).pickup, "11:30 PM");
  assert.equal(buildTicket({ ...common, order: { ...base, pickupAt: null, newPickupAt: moved } }).pickup, "11:30 PM");
  assert.equal(buildTicket({ ...common, order: { ...base, pickupAt: null } }).pickup, "ASAP");
});
