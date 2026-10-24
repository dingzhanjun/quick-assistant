// Copy the menu from another restaurant the user owns: dishes, categories, modifier groups + options and the links between them.
// Needs a migrated Postgres (DATABASE_URL); creates two throwaway restaurants and a user and removes them afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";

const run = randomUUID().slice(0, 8);
const SRC = `cp-src-${run}`, DST = `cp-dst-${run}`, STRANGER = `cp-str-${run}`, STAFFONLY = `cp-stf-${run}`;
const USER = `u-${run}`;
let current = DST;
let role = "owner";
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/tenant.ts"), { namedExports: { requireTenant: async () => ({ tenantId: current, role, user: { id: USER, email: `owner-${run}@example.com` } }) } });
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");
let A: typeof import("../src/app/dashboard/menu/copy-actions");
let snapshot: typeof import("../src/lib/menu-copy")["readMenuSnapshot"];

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  A = await import("../src/app/dashboard/menu/copy-actions");
  ({ readMenuSnapshot: snapshot } = await import("../src/lib/menu-copy"));
  const now = new Date();
  for (const id of [SRC, DST, STRANGER, STAFFONLY]) await db.insert(S.organization).values({ id, name: `Yifan ${id}`, slug: id, createdAt: now });
  await db.insert(S.user).values({ id: USER, name: "Owner", email: `owner-${run}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
  await db.insert(S.member).values([
    { id: randomUUID(), organizationId: SRC, userId: USER, role: "owner", createdAt: now },
    { id: randomUUID(), organizationId: DST, userId: USER, role: "owner", createdAt: now },
    { id: randomUUID(), organizationId: STAFFONLY, userId: USER, role: "member", createdAt: now }, // staff there, not owner
  ]);
  // the source menu: 2 categories, 1 modifier group with 2 options, 3 dishes (one in two categories, one with the group)
  const [drinks] = await db.insert(S.categories).values({ tenantId: SRC, name: "Drinks", sortOrder: 0 }).returning();
  const [veg] = await db.insert(S.categories).values({ tenantId: SRC, name: "Vegetarian", sortOrder: 1 }).returning();
  const [size] = await db.insert(S.modifierGroups).values({ tenantId: SRC, name: "Size", required: true, maxSelect: 1 }).returning();
  await db.insert(S.modifierOptions).values([
    { tenantId: SRC, groupId: size.id, name: "Regular", priceDeltaCents: 0, sortOrder: 0 },
    { tenantId: SRC, groupId: size.id, name: "Large", priceDeltaCents: 200, sortOrder: 1 },
  ]);
  const [tea] = await db.insert(S.menuItems).values({ tenantId: SRC, name: "Green Tea", description: "Hot", priceCents: 400 }).returning();
  const [rice] = await db.insert(S.menuItems).values({ tenantId: SRC, name: "Fried Rice", priceCents: 950 }).returning();
  await db.insert(S.menuItems).values({ tenantId: SRC, name: "Soup", priceCents: 500, available: false });
  await db.insert(S.menuItemCategories).values([{ menuItemId: tea.id, categoryId: drinks.id }, { menuItemId: tea.id, categoryId: veg.id }]);
  await db.insert(S.menuItemModifierGroups).values({ menuItemId: tea.id, groupId: size.id, sortOrder: 0 });
  void rice;
  // the destination already sells Green Tea, cheaper, and has a "Drinks" category of its own
  await db.insert(S.menuItems).values({ tenantId: DST, name: "green tea", priceCents: 350 });
  await db.insert(S.categories).values({ tenantId: DST, name: "drinks", sortOrder: 0 });
});
after(async () => {
  await db.delete(S.auditLogs).where(eq(S.auditLogs.entityId, SRC));
  for (const id of [SRC, DST, STRANGER, STAFFONLY]) await db.delete(S.organization).where(eq(S.organization.id, id));
  await db.delete(S.user).where(eq(S.user.id, USER));
  process.exit(0);
});

const dest = () => snapshot(db as never, DST);

test("preview: add mode shows what is missing and changes nothing", async () => {
  current = DST;
  const r = await A.previewMenuCopy(SRC, "add");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.plan.newItems.sort(), ["Fried Rice", "Soup"]);
  assert.equal(r.plan.unchangedItems, 1, "Green Tea exists (matched by name, ignoring case): left as it is in add mode");
  assert.deepEqual(r.plan.newCategories, ["Vegetarian"], "Drinks exists already");
  assert.deepEqual(r.plan.newGroups, ["Size"]);
  assert.equal((await dest()).items.length, 1, "a preview changes nothing");
});

test("add mode copies what is missing (dishes, categories, groups, options, links) and leaves existing dishes alone", async () => {
  const r = await A.applyMenuCopy(SRC, "add");
  assert.deepEqual(r, { ok: true, created: 2, updated: 0, categories: 1, groups: 1 });
  const d = await dest();
  assert.deepEqual(d.items.map((i) => i.name).sort(), ["Fried Rice", "Soup", "green tea"]);
  const tea = d.items.find((i) => i.name === "green tea")!;
  assert.equal(tea.priceCents, 350, "the existing dish was not touched");
  assert.deepEqual(tea.categoryNames, [], "no links added to an existing dish in add mode");
  assert.equal(d.items.find((i) => i.name === "Soup")!.available, false, "availability is copied");
  assert.deepEqual(d.categories.map((c) => c.name), ["drinks", "Vegetarian"]);
  const size = d.groups.find((g) => g.name === "Size")!;
  assert.deepEqual([size.required, size.maxSelect], [true, 1]);
  assert.deepEqual(size.options.map((o) => [o.name, o.priceDeltaCents]), [["Regular", 0], ["Large", 200]]);
  // the source is untouched
  const src = await snapshot(db as never, SRC);
  assert.equal(src.items.length, 3);
  // doing it again copies nothing
  assert.deepEqual(await A.applyMenuCopy(SRC, "add"), { ok: true, created: 0, updated: 0, categories: 0, groups: 0 });
  const audits = await db.select().from(S.auditLogs).where(eq(S.auditLogs.entityId, SRC));
  assert.equal(audits.filter((a) => a.action === "menu.copied").length, 1, "only a copy that changed something is audited");
});

test("update mode brings existing dishes in line (price, names, links) and adds links, never removes", async () => {
  const p = await A.previewMenuCopy(SRC, "update");
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.plan.updatedItems.length, 1);
  assert.deepEqual(p.plan.updatedItems[0].changes.sort(), ["categories", "description", "modifiers", "price"].sort());
  assert.deepEqual(await A.applyMenuCopy(SRC, "update"), { ok: true, created: 0, updated: 1, categories: 0, groups: 0 });
  const tea = (await dest()).items.find((i) => i.name === "green tea")!;
  assert.equal(tea.priceCents, 400);
  assert.deepEqual(tea.categoryNames.sort(), ["Vegetarian", "drinks"]);
  assert.deepEqual(tea.groupNames, ["Size"]);
  assert.deepEqual(await A.applyMenuCopy(SRC, "update"), { ok: true, created: 0, updated: 0, categories: 0, groups: 0 }, "idempotent");
});

test("only a restaurant you OWN can be copied from; not yourself, not a stranger's, not one where you are only staff", async () => {
  current = DST;
  for (const id of [DST, STRANGER, STAFFONLY, "nope"]) {
    const r = await A.previewMenuCopy(id, "add");
    assert.equal(r.ok, false, id);
    assert.equal((await A.applyMenuCopy(id, "add")).ok, false, id);
  }
  assert.equal((await A.previewMenuCopy(SRC, "everything")).ok, false, "unknown mode");
  // the stranger's menu really was not read or changed
  assert.equal((await snapshot(db as never, STRANGER)).items.length, 0);
});

test("staff of the destination cannot copy into it", async () => {
  role = "member";
  try {
    assert.equal((await A.previewMenuCopy(SRC, "add")).ok, false);
    assert.equal((await A.applyMenuCopy(SRC, "add")).ok, false);
  } finally {
    role = "owner";
  }
});
