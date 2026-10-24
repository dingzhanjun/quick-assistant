// Audit log (action logs): every mutation writes one entry with who/what; writing never breaks the action.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

process.env.AGENT_API_KEY = "test-agent-key";
const run = randomUUID().slice(0, 8);
const T = `aud-${run}`;
const USER = { id: `u-${run}`, email: `owner-${run}@example.com` };
let role = "owner";
const deferred: (() => Promise<void> | void)[] = [];
mock.module(pathToFileURL(path.resolve("src/lib/tenant.ts")).href, {
  namedExports: { requireTenant: async () => ({ tenantId: T, role, user: USER }) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
// after() callbacks run when the test asks for them, like Next does once the response is sent.
mock.module("next/server", { namedExports: { NextResponse, after: (fn: () => Promise<void> | void) => void deferred.push(fn) } });

let db: typeof import("../src/db")["db"];
let S: typeof import("../src/db/schema");

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  await db.insert(S.organization).values({ id: T, name: `Audit ${run}`, slug: T, createdAt: new Date() });
});
after(async () => {
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  await db.delete(S.organization).where(eq(S.organization.id, T));
  process.exit(0);
});

const logs = async (action?: string) =>
  (await db.select().from(S.auditLogs).where(action ? and(eq(S.auditLogs.tenantId, T), eq(S.auditLogs.action, action)) : eq(S.auditLogs.tenantId, T)).orderBy(desc(S.auditLogs.createdAt)));

test("menu actions are logged with who and what changed", async () => {
  const menu = await import("../src/app/dashboard/menu/actions");
  assert.equal((await menu.saveMenuItem(null, { name: "Soup", priceCents: 500, available: true, groupIds: [] })).ok, true);
  const [item] = await db.select().from(S.menuItems).where(eq(S.menuItems.tenantId, T));

  const [created] = await logs("menu_item.created");
  assert.equal(created.actorLabel, USER.email);
  assert.equal(created.actorType, "user");
  assert.equal(created.entityId, item.id);
  assert.match(created.summary, /Soup/);

  await menu.saveMenuItem(item.id, { name: "Soup", priceCents: 650, available: true, groupIds: [] });
  const [updated] = await logs("menu_item.updated");
  assert.deepEqual((updated.details as { changes: Record<string, unknown> }).changes.priceCents, [500, 650]);

  await menu.saveMenuItem(item.id, { name: "Soup", priceCents: 650, available: true, groupIds: [] });
  assert.equal((await logs("menu_item.updated")).length, 1, "a save with no changes must not log");

  await menu.setAvailability(item.id, false);
  assert.match((await logs("menu_item.availability_changed"))[0].summary, /sold out/);
  await menu.deleteMenuItem(item.id);
  assert.equal((await logs("menu_item.deleted")).length, 1);
  await menu.deleteMenuItem(item.id); // already gone: nothing happened, nothing logged
  assert.equal((await logs("menu_item.deleted")).length, 1);
});

test("modifier, settings and order status changes are logged", async () => {
  const mods = await import("../src/app/dashboard/modifiers/actions");
  const settings = await import("../src/app/dashboard/settings/actions");
  const ord = await import("../src/app/dashboard/orders/actions");

  await mods.saveModifierGroup(null, { name: "Size", required: false, maxSelect: 1, options: [{ name: "Large", priceDeltaCents: 200, available: true }] });
  const [g] = await db.select().from(S.modifierGroups).where(eq(S.modifierGroups.tenantId, T));
  assert.equal((await logs("modifier_group.created")).length, 1);
  await mods.saveModifierGroup(g.id, { name: "Size", required: false, maxSelect: 1, options: [{ name: "Large", priceDeltaCents: 250, available: true }] });
  assert.equal((await logs("modifier_group.updated")).length, 1);
  await mods.deleteModifierGroup(g.id);
  assert.equal((await logs("modifier_group.deleted")).length, 1);

  await settings.saveNotifications("a@example.com", true);
  await settings.saveAddress("  12  Oak   Lane ");
  await settings.saveAddress("12 Oak Lane"); // same after trimming: not logged again
  const [stored] = await db.select().from(S.tenantSettings).where(eq(S.tenantSettings.tenantId, T));
  assert.equal(stored.address, "12 Oak Lane");
  assert.equal((await logs("settings.address_updated")).length, 1);
  await settings.saveHours("Europe/Paris", { mon: [["09:00", "17:00"]] });
  assert.equal((await logs("settings.notifications_updated")).length, 1);
  assert.equal((await logs("settings.hours_updated")).length, 1);

  const [o] = await db.insert(S.orders).values({ tenantId: T, orderNumber: 1 }).returning();
  await ord.setOrderStatus(o.id, "preparing");
  await ord.setOrderStatus(o.id, "preparing"); // no change: not logged
  await ord.setOrderStatus(o.id, "cancelled");
  assert.equal((await logs("order.updated")).length, 1);
  const [c] = await logs("order.cancelled");
  assert.deepEqual((c.details as { from: string; to: string }).to, "cancelled");
});

test("staff actions are attributed to the staff member; refused actions leave no entry", async () => {
  role = "member";
  try {
    const menu = await import("../src/app/dashboard/menu/actions");
    const before = (await logs()).length;
    assert.equal((await menu.saveMenuItem(null, { name: "Nope", priceCents: 1, available: true, groupIds: [] })).ok, false);
    assert.equal((await logs()).length, before);
  } finally {
    role = "owner";
  }
});

test("an order from the phone agent is logged with masked caller and total", async () => {
  const [dish] = await db.insert(S.menuItems).values({ tenantId: T, name: "Pie", priceCents: 400 }).returning();
  const num = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
  await db.insert(S.phoneNumbers).values({ e164: num, tenantId: T });
  const orders = await import("../src/app/api/agent/orders/route");
  const res: Response = await orders.POST(
    new Request("http://t/api/agent/orders", {
      method: "POST",
      headers: { authorization: "Bearer test-agent-key", "content-type": "application/json" },
      body: JSON.stringify({ to: num, caller: "+15551234567", customer_name: "Pat", items: [{ item_id: dish.id, quantity: 2 }] }),
    }),
  );
  assert.equal(res.status, 200);
  for (const fn of deferred.splice(0)) await fn();
  const [entry] = await logs("order.created");
  assert.equal(entry.actorType, "agent");
  const d = entry.details as { caller: string; totalCents: number; customerName: string };
  assert.deepEqual([d.caller, d.totalCents, d.customerName], ["***4567", 800, "Pat"]);
  assert.ok(!JSON.stringify(entry).includes("5551234567"), "full caller number leaked into the audit log");
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, num));
});

test("audit() never throws, even when the write fails", async () => {
  const { audit } = await import("../src/lib/audit");
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    // a BigInt cannot be serialized to JSON, so the insert genuinely fails
    await audit({ action: "order.created", actor: { type: "agent" }, summary: "x", details: { n: BigInt(1) } });
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1, "the failure should be reported on the console");
  assert.match(String(errors[0][0]), /\[audit\]/);
});
