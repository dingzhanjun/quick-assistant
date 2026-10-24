// Live orders board: a database trigger notifies, the hub fans out per restaurant, the SSE route streams it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";

const run = randomUUID().slice(0, 8);
const A = `live-a-${run}`, B = `live-b-${run}`;
let who: { ok: true; tenantId: string; role: string; user: object } | { ok: false; redirect: string } = { ok: false, redirect: "/" };
mock.module(pathToFileURL(path.resolve("src/lib/tenant.ts")).href, { namedExports: { resolveTenant: async () => who } });

let db: typeof import("../src/db")["db"];
let S: typeof import("../src/db/schema");
let hub: typeof import("../src/lib/order-events")["ordersHub"];

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  ({ ordersHub: hub } = await import("../src/lib/order-events"));
  for (const id of [A, B]) await db.insert(S.organization).values({ id, name: id, slug: id, createdAt: new Date() });
});
after(async () => {
  for (const id of [A, B]) await db.delete(S.organization).where(eq(S.organization.id, id));
  process.exit(0);
});

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

test("an order change notifies only the listeners of that restaurant", async () => {
  let a = 0, b = 0;
  const offA = hub.subscribe(A, () => a++);
  const offB = hub.subscribe(B, () => b++);
  await new Promise((r) => setTimeout(r, 400)); // let LISTEN establish

  const [order] = await db.insert(S.orders).values({ tenantId: A, orderNumber: 1 }).returning();
  assert.ok(await waitFor(() => a >= 1), "insert did not notify");
  const afterInsert = a;
  await db.update(S.orders).set({ status: "preparing" }).where(eq(S.orders.id, order.id));
  assert.ok(await waitFor(() => a > afterInsert), "status change did not notify");
  assert.equal(b, 0, "restaurant B was notified about A's order");

  offA();
  const frozen = a;
  await db.update(S.orders).set({ status: "ready" }).where(eq(S.orders.id, order.id));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(a, frozen, "an unsubscribed listener was still called");
  offB();
});

test("the stream route refuses anonymous visitors and streams ready + order events to the signed-in restaurant", async () => {
  const route = await import("../src/app/api/dashboard/orders/stream/route");
  who = { ok: false, redirect: "/" };
  assert.equal((await route.GET(new Request("http://t/api/dashboard/orders/stream"))).status, 401);

  who = { ok: true, tenantId: A, role: "member", user: {} };
  const ctl = new AbortController();
  const res = await route.GET(new Request("http://t/api/dashboard/orders/stream", { signal: ctl.signal }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += dec.decode(value);
    }
  })();
  assert.ok(await waitFor(() => text.includes("event: ready")), "no ready event");
  await new Promise((r) => setTimeout(r, 400));

  await db.insert(S.orders).values({ tenantId: B, orderNumber: 1 }); // another restaurant: must not appear
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!text.includes("event: orders"), "got an event for another restaurant");
  await db.insert(S.orders).values({ tenantId: A, orderNumber: 2 });
  assert.ok(await waitFor(() => text.includes("event: orders")), "no order event");

  const before = hub.subscriberCount;
  ctl.abort(); // closing the browser tab unsubscribes
  assert.ok(await waitFor(() => hub.subscriberCount < before), "the subscription leaked after the client left");
  void pump.catch(() => {});
});
