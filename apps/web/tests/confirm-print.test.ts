// "Confirm & Print": with print_timing = on_accept a new order prints only when staff confirm it on the board.
// Needs a migrated Postgres (DATABASE_URL); creates a throwaway restaurant and removes it afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";

const T = `cp-${randomUUID().slice(0, 8)}`;
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/tenant.ts"), {
  namedExports: { requireTenant: async () => ({ tenantId: T, role: "member", user: { id: "u", email: "u@x" } }) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");
let actions: typeof import("../src/app/dashboard/orders/actions");
let P: typeof import("../src/lib/print/jobs");

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  actions = await import("../src/app/dashboard/orders/actions");
  P = await import("../src/lib/print/jobs");
  await db.insert(S.organization).values({ id: T, name: "Confirm test", slug: T, createdAt: new Date() });
  await db.insert(S.printers).values({ tenantId: T, name: "Kitchen" });
});
after(async () => {
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  await db.delete(S.organization).where(eq(S.organization.id, T));
  process.exit(0);
});

const mkOrder = async (n: number) => (await db.insert(S.orders).values({ tenantId: T, orderNumber: n, customerName: "Pat" }).returning())[0];
const jobs = (orderId: string) => db.select().from(S.printJobs).where(eq(S.printJobs.orderId, orderId));
const setTiming = (t: "immediate" | "on_accept") =>
  db.insert(S.tenantSettings).values({ tenantId: T, printTiming: t }).onConflictDoUpdate({ target: S.tenantSettings.tenantId, set: { printTiming: t } });

test("with print-after-confirmation nothing prints until Confirm & Print, then exactly one ticket", async () => {
  await setTiming("on_accept");
  const o = await mkOrder(1);
  // what the agent's order route does for this setting: it does NOT enqueue a ticket
  assert.equal((await jobs(o.id)).length, 0);

  assert.deepEqual(await actions.setOrderStatus(o.id, "preparing"), { ok: true }); // the Confirm & Print button
  const made = await jobs(o.id);
  assert.equal(made.length, 1);
  assert.equal(made[0].kind, "new");
  assert.equal(made[0].status, "pending");

  // later steps and a repeated click never print it again
  await actions.setOrderStatus(o.id, "ready");
  await actions.setOrderStatus(o.id, "completed");
  assert.equal((await jobs(o.id)).length, 1);
  assert.equal(await P.enqueuePrint(T, o.id, "new"), 0, "the same ticket is never made twice");
});

test("cancelling an order that was never confirmed prints nothing (the kitchen never saw it)", async () => {
  await setTiming("on_accept");
  const o = await mkOrder(2);
  await actions.setOrderStatus(o.id, "cancelled");
  assert.equal((await jobs(o.id)).length, 0);
});

test("with immediate printing the status buttons do not create tickets", async () => {
  await setTiming("immediate");
  const o = await mkOrder(3);
  await actions.setOrderStatus(o.id, "preparing");
  assert.equal((await jobs(o.id)).length, 0, "the agent's order route prints these, not the board");
});

test("confirming the order also texts the customer the link, once, when they gave a number", async () => {
  await setTiming("on_accept");
  process.env.SMS_PROVIDER = "log";
  const withNumber = (await db.insert(S.orders).values({ tenantId: T, orderNumber: 10, customerName: "Pat", contactNumber: "+14045550133", smsCount: 1, publicToken: "A".repeat(22) }).returning())[0];
  const without = await mkOrder(11);
  const texts = async (id: string) => (await db.select().from(S.jobs).where(eq(S.jobs.type, "sms"))).filter((j) => j.payload.orderId === id);
  assert.equal((await texts(withNumber.id)).length, 0, "not before the confirmation");
  await actions.setOrderStatus(withNumber.id, "preparing"); // Confirm & Print
  await actions.setOrderStatus(withNumber.id, "ready");
  const sent = await texts(withNumber.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.to, "+14045550133");
  assert.match(sent[0].payload.text, /^Thanks for your order, to view your order #10, tap this link: .*\/orders\/A{22}$/);
  await actions.setOrderStatus(without.id, "preparing");
  assert.equal((await texts(without.id)).length, 0, "no number, no text");
  await db.delete(S.jobs).where(sql`${S.jobs.payload}->>'tenantId' = ${T}`);
});
