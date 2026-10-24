// A cancelled order texts the customer (if they gave a number): cancelled by the restaurant on the board, or by the customer
// on the phone. A changed order that REPLACES the old one does not (the customer just made the new one).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

process.env.AGENT_API_KEY = "test-agent-key";
process.env.SMS_PROVIDER = "log";
const T = `ct-${randomUUID().slice(0, 8)}`;
const NUM = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
const CALLER = `+1404${Math.floor(1000000 + Math.random() * 8999999)}`;
const afterJobs: (() => Promise<void>)[] = [];
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/tenant.ts"), {
  namedExports: { requireTenant: async () => ({ tenantId: T, role: "member", user: { id: "u", email: "u@x" } }) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
mock.module("next/server", { namedExports: { NextResponse, after: (fn: () => Promise<void>) => afterJobs.push(fn) } });

type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");
let actions: typeof import("../src/app/dashboard/orders/actions");

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  actions = await import("../src/app/dashboard/orders/actions");
  await db.insert(S.organization).values({ id: T, name: "Cancel text", slug: T, createdAt: new Date() });
  await db.insert(S.phoneNumbers).values({ e164: NUM, tenantId: T });
});
after(async () => {
  await db.delete(S.jobs).where(sql`${S.jobs.payload}->>'tenantId' = ${T}`); // only this file's jobs: other test files share the table
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  await db.delete(S.organization).where(eq(S.organization.id, T));
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, NUM));
  process.exit(0);
});

const mkOrder = async (n: number, extra: Partial<typeof S.orders.$inferInsert> = {}) =>
  (await db.insert(S.orders).values({ tenantId: T, orderNumber: n, customerName: "Pat", publicToken: randomUUID().replace(/-/g, "").slice(0, 22), ...extra }).returning())[0];
const texts = async (orderId: string) => (await db.select().from(S.jobs).where(eq(S.jobs.type, "sms"))).filter((j) => j.payload.orderId === orderId);

test("the restaurant cancels on the board: the customer is texted once", async () => {
  const o = await mkOrder(1, { contactNumber: "+14045550177", smsCount: 1 });
  await actions.setOrderStatus(o.id, "cancelled");
  await actions.setOrderStatus(o.id, "cancelled"); // pressed twice
  const sent = await texts(o.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.to, "+14045550177");
  assert.equal(sent[0].payload.text, `Your order #1 has been cancelled. Details: ${(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "")}/orders/${o.publicToken}`);
});

test("no number, or texting switched off: no text", async () => {
  const noNumber = await mkOrder(2);
  await actions.setOrderStatus(noNumber.id, "cancelled");
  assert.equal((await texts(noNumber.id)).length, 0);

  await db.insert(S.tenantSettings).values({ tenantId: T, textOrderLink: false });
  const off = await mkOrder(3, { contactNumber: "+14045550178", smsCount: 1 });
  await actions.setOrderStatus(off.id, "cancelled");
  assert.equal((await texts(off.id)).length, 0);
  await db.update(S.tenantSettings).set({ textOrderLink: true }).where(eq(S.tenantSettings.tenantId, T));
});

test("the customer cancels by phone: the cancellation is confirmed by text", async () => {
  const mod = await import("../src/app/api/agent/orders/cancel/route");
  const o = await mkOrder(4, { callerNumber: CALLER, contactNumber: "+14045550179", smsCount: 1 });
  const res = await mod.POST(new Request("http://t/api/agent/orders/cancel", {
    method: "POST",
    headers: { authorization: "Bearer test-agent-key", "content-type": "application/json" },
    body: JSON.stringify({ to: NUM, order_number: 4, caller: CALLER }),
  }));
  assert.deepEqual(await res.json(), { cancelled: true, order_number: 4 });
  for (const job of afterJobs.splice(0)) await job();
  const sent = await texts(o.id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /^Your order #4 has been cancelled\. Details: /);
});

test("a changed order replacing the old one does not text 'cancelled'", async () => {
  const mod = await import("../src/app/api/agent/orders/route");
  const [dish] = await db.insert(S.menuItems).values({ tenantId: T, name: "Soup", priceCents: 600 }).returning();
  const old = await mkOrder(5, { callerNumber: CALLER, contactNumber: "+14045550180", smsCount: 1 });
  const res = await mod.POST(new Request("http://t/api/agent/orders", {
    method: "POST",
    headers: { authorization: "Bearer test-agent-key", "content-type": "application/json" },
    body: JSON.stringify({ to: NUM, caller: CALLER, replaces_order_number: 5, idempotency_key: `k-${T}`, items: [{ item_id: dish.id, quantity: 1 }] }),
  }));
  assert.equal(res.status, 200);
  for (const job of afterJobs.splice(0)) await job();
  assert.equal((await db.select().from(S.orders).where(eq(S.orders.id, old.id)))[0].status, "cancelled");
  assert.equal((await texts(old.id)).length, 0);
});
