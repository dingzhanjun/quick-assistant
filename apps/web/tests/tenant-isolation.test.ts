// Tenant isolation (LAUNCH_PLAN P2.6): acting as restaurant A must never read or change restaurant B's data.
// Needs a migrated Postgres (DATABASE_URL); creates two throwaway restaurants and removes them afterwards.
// Server actions are called directly with `requireTenant` mocked to return whichever tenant the test picks.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

process.env.AGENT_API_KEY = "test-agent-key";
let current = "";
let currentRole = "owner";
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/tenant.ts"), {
  namedExports: { requireTenant: async () => ({ tenantId: current, role: currentRole, user: { id: "u", email: "u@x" } }) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
mock.module("next/server", { namedExports: { NextResponse, after: () => {} } });

const run = randomUUID().slice(0, 8);
const A = `iso-a-${run}`, B = `iso-b-${run}`;
const NUM_B = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
let ids: { item: string; group: string; category: string; option: string; order: string; printer: string; printAgent: string };

type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  for (const [id, n] of [[A, "A"], [B, "B"]] as const) {
    await db.insert(S.organization).values({ id, name: `Iso ${n}`, slug: id, createdAt: new Date() });
  }
  await db.insert(S.phoneNumbers).values({ e164: NUM_B, tenantId: B });
  await db.insert(S.menuItems).values({ tenantId: A, name: "A seed dish", priceCents: 500 });
  const [item] = await db.insert(S.menuItems).values({ tenantId: B, name: "B dish", priceCents: 1000 }).returning();
  const [group] = await db.insert(S.modifierGroups).values({ tenantId: B, name: "B group", required: false, maxSelect: 1 }).returning();
  const [option] = await db.insert(S.modifierOptions).values({ tenantId: B, groupId: group.id, name: "B opt", priceDeltaCents: 0 }).returning();
  const [cat] = await db.insert(S.categories).values({ tenantId: B, name: "B category" }).returning();
  await db.insert(S.menuItemCategories).values({ menuItemId: item.id, categoryId: cat.id });
  const [order] = await db.insert(S.orders).values({ tenantId: B, orderNumber: 1 }).returning();
  const [pa] = await db.insert(S.printAgents).values({ tenantId: B, name: "B Pi", tokenHash: `h-${run}` }).returning();
  const [pr] = await db.insert(S.printers).values({ tenantId: B, agentId: pa.id, name: "B Kitchen", deviceKey: "lp0" }).returning();
  ids = { item: item.id, group: group.id, category: cat.id, option: option.id, order: order.id, printer: pr.id, printAgent: pa.id };
});

after(async () => {
  for (const id of [A, B]) await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, id));
  for (const id of [A, B]) await db.delete(S.organization).where(eq(S.organization.id, id));
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, NUM_B));
  process.exit(0); // the shared pg client would keep the process alive
});

const snapshot = async () => ({
  item: await db.select().from(S.menuItems).where(eq(S.menuItems.id, ids.item)),
  group: await db.select().from(S.modifierGroups).where(eq(S.modifierGroups.id, ids.group)),
  options: await db.select().from(S.modifierOptions).where(eq(S.modifierOptions.groupId, ids.group)),
  categories: await db.select().from(S.categories).where(eq(S.categories.tenantId, B)),
  categoryLinks: await db.select().from(S.menuItemCategories).where(eq(S.menuItemCategories.menuItemId, ids.item)),
  order: await db.select().from(S.orders).where(eq(S.orders.id, ids.order)),
  settings: await db.select().from(S.tenantSettings).where(eq(S.tenantSettings.tenantId, B)),
  printers: await db.select().from(S.printers).where(eq(S.printers.tenantId, B)),
  printAgents: await db.select().from(S.printAgents).where(eq(S.printAgents.tenantId, B)),
  printJobs: await db.select({ id: S.printJobs.id }).from(S.printJobs).where(eq(S.printJobs.tenantId, B)),
  printCommands: await db.select().from(S.printAgentCommands).where(eq(S.printAgentCommands.tenantId, B)),
});

test("dashboard actions as restaurant A cannot touch restaurant B", async () => {
  current = A;
  const menu = await import("../src/app/dashboard/menu/actions");
  const mods = await import("../src/app/dashboard/modifiers/actions");
  const cats = await import("../src/app/dashboard/categories/actions");
  const imp = await import("../src/app/dashboard/menu/import-actions");
  const cp = await import("../src/app/dashboard/menu/copy-actions");
  const ord = await import("../src/app/dashboard/orders/actions");
  const settings = await import("../src/app/dashboard/settings/actions");
  const before = await snapshot();

  await menu.saveMenuItem(ids.item, { name: "HACKED", priceCents: 1, available: false, groupIds: [] });
  await menu.setAvailability(ids.item, false);
  await menu.deleteMenuItem(ids.item);
  await mods.saveModifierGroup(ids.group, {
    name: "HACKED", required: true, maxSelect: 2,
    options: [{ id: ids.option, name: "HACKED", priceDeltaCents: 999, available: false }],
  });
  await mods.deleteModifierGroup(ids.group);
  await cats.saveCategory(ids.category, { name: "HACKED" });
  await cats.moveCategory(ids.category, "down");
  await cats.deleteCategory(ids.category);
  // importing "B dish" / "B category" as A matches nothing of B's (it only creates A's own copies afterwards)
  await imp.previewMenuImport("name,price,categories\nB dish,1,B category\n");
  // copying B's menu: this user is not a member of B at all
  await cp.previewMenuCopy(B, "add");
  await cp.applyMenuCopy(B, "update");
  await ord.setOrderStatus(ids.order, "cancelled");
  await ord.changePickupTime(ids.order, "23:59"); // B's order: unknown to restaurant A
  await settings.saveNotifications("a@example.com", false);
  await settings.saveHours("Europe/Paris", { mon: [["09:00", "10:00"]] });
  await settings.saveTextOrders(false);
  await settings.saveAddress("1 Hacker Road");
  await settings.saveHumanLine("+14155550155");
  const pr = await import("../src/app/dashboard/settings/print-actions");
  await pr.updatePrinter(ids.printer, { name: "HACKED", paperWidthMm: 58, copies: 3, enabled: false });
  await pr.testPrint(ids.printer);
  await pr.sendAgentCommand(ids.printAgent, "reboot");
  await pr.newPairingCodeFor(ids.printAgent);
  await pr.revokePrintAgent(ids.printAgent);
  await pr.deletePrintAgent(ids.printAgent);
  await pr.removePrinter(ids.printer);
  await ord.reprintOrder(ids.order);
  // A new item that tries to attach B's modifier group must not link it.
  await menu.saveMenuItem(null, { name: "A dish", priceCents: 100, available: true, groupIds: [ids.group], categoryIds: [ids.category] });

  assert.deepEqual(await snapshot(), before);
  const links = await db.select().from(S.menuItemModifierGroups).where(eq(S.menuItemModifierGroups.groupId, ids.group));
  assert.equal(links.length, 0, "B's group was attached to an A item");
  const catLinks = await db.select().from(S.menuItemCategories).where(eq(S.menuItemCategories.categoryId, ids.category));
  assert.equal(catLinks.length, 1, "B's category got attached to an A item (only B's own link may exist)");
});

async function agent(pathname: string, body: unknown) {
  const mod = await import(`../src/app/api/agent/${pathname}/route`);
  const req = new Request(`http://t/api/agent/${pathname}`, {
    method: "POST",
    headers: { authorization: "Bearer test-agent-key", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return mod.POST(req) as Promise<Response>;
}

test("agent order for restaurant A cannot use B's dishes or options", async () => {
  const [aItem] = await db.select().from(S.menuItems).where(eq(S.menuItems.tenantId, A));
  const NUM_A = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
  await db.insert(S.phoneNumbers).values({ e164: NUM_A, tenantId: A });
  try {
    // A's dialed number, B's dish id
    let res = await agent("orders", { to: NUM_A, items: [{ item_id: ids.item, quantity: 1 }] });
    assert.equal(res.status, 422);
    // A's own dish with B's option
    res = await agent("orders", { to: NUM_A, items: [{ item_id: aItem.id, quantity: 1, option_ids: [ids.option] }] });
    assert.equal(res.status, 422);
    // The same idempotency key under another restaurant is a different order, not B's.
    const key = `k-${run}`;
    const ok1 = await agent("orders", { to: NUM_A, idempotency_key: key, items: [{ item_id: aItem.id, quantity: 1 }] });
    const ok2 = await agent("orders", { to: NUM_B, idempotency_key: key, items: [{ item_id: ids.item, quantity: 1 }] });
    assert.equal(ok1.status, 200);
    assert.equal(ok2.status, 200);
    assert.equal(((await ok2.json()) as { duplicate?: boolean }).duplicate, undefined);
  } finally {
    await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, NUM_A));
  }
});

test("staff (non-owner) cannot change menu, modifiers or settings, but can work orders", async () => {
  current = B;
  currentRole = "member";
  try {
    const menu = await import("../src/app/dashboard/menu/actions");
    const mods = await import("../src/app/dashboard/modifiers/actions");
    const cats = await import("../src/app/dashboard/categories/actions");
    const imp = await import("../src/app/dashboard/menu/import-actions");
    const cp = await import("../src/app/dashboard/menu/copy-actions");
    const ord = await import("../src/app/dashboard/orders/actions");
    const settings = await import("../src/app/dashboard/settings/actions");
    const pr = await import("../src/app/dashboard/settings/print-actions");
    const before = await snapshot();

    const denied = [
      await menu.saveMenuItem(ids.item, { name: "STAFF", priceCents: 1, available: true, groupIds: [] }),
      await menu.saveMenuItem(null, { name: "new", priceCents: 1, available: true, groupIds: [] }),
      await menu.deleteMenuItem(ids.item),
      await mods.saveModifierGroup(ids.group, { name: "STAFF", required: false, maxSelect: 1, options: [{ name: "x", priceDeltaCents: 0, available: true }] }),
      await mods.deleteModifierGroup(ids.group),
      await cats.saveCategory(ids.category, { name: "STAFF" }),
      await cats.saveCategory(null, { name: "STAFF NEW" }),
      await cats.moveCategory(ids.category, "up"),
      await cats.deleteCategory(ids.category),
      await imp.previewMenuImport("name,price\nB dish,1\n"),
      await imp.applyMenuImport("name,price\nB dish,1\n"),
      await cp.previewMenuCopy(B, "add"),
      await cp.applyMenuCopy(B, "add"),
      await settings.saveNotifications("staff@example.com", false),
      await settings.saveHours("Europe/Paris", null),
      await settings.saveTextOrders(false),
      await settings.saveAddress("1 Staff Street"),
      await settings.saveHumanLine("+14155550166"),
      await pr.savePrintSettings("on_accept"),
      await pr.createPrintAgent("staff agent"),
      await pr.createSetupFiles({ name: "staff", hostname: "staff-pi" }),
      await pr.updatePrinter(ids.printer, { name: "STAFF", paperWidthMm: 58, copies: 3, enabled: false }),
      await pr.removePrinter(ids.printer),
      await pr.testPrint(ids.printer),
      await pr.sendAgentCommand(ids.printAgent, "reboot"),
      await pr.revokePrintAgent(ids.printAgent),
      await pr.deletePrintAgent(ids.printAgent),
      await pr.newPairingCodeFor(ids.printAgent),
    ];
    assert.ok(denied.every((r) => r.ok === false), "a staff action succeeded");
    assert.deepEqual(await snapshot(), before);

    // Allowed for staff: sold-out toggle and order status.
    assert.equal((await menu.setAvailability(ids.item, false)).ok, true);
    assert.equal((await ord.setOrderStatus(ids.order, "preparing")).ok, true);
    assert.equal((await ord.reprintOrder(ids.order)).ok, true, "staff can reprint a ticket");
  } finally {
    currentRole = "owner";
  }
});
