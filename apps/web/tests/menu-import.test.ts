// Menu CSV import against a real database: matching by name, partial columns, categories, all-or-nothing, owner only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";

const run = randomUUID().slice(0, 8);
const T = `imp-${run}`, OTHER = `imp-o-${run}`;
let role = "owner";
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/tenant.ts"), {
  namedExports: { requireTenant: async () => ({ tenantId: T, role, user: { id: "u", email: "u@x" } }) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");
let imp: typeof import("../src/app/dashboard/menu/import-actions");

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  imp = await import("../src/app/dashboard/menu/import-actions");
  for (const id of [T, OTHER]) await db.insert(S.organization).values({ id, name: id, slug: id, createdAt: new Date() });
});
after(async () => {
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  for (const id of [T, OTHER]) await db.delete(S.organization).where(eq(S.organization.id, id));
  process.exit(0);
});

const items = () => db.select().from(S.menuItems).where(eq(S.menuItems.tenantId, T));
const links = async () => {
  const rows = await db
    .select({ item: S.menuItems.name, cat: S.categories.name })
    .from(S.menuItemCategories)
    .innerJoin(S.menuItems, eq(S.menuItems.id, S.menuItemCategories.menuItemId))
    .innerJoin(S.categories, eq(S.categories.id, S.menuItemCategories.categoryId))
    .where(eq(S.menuItems.tenantId, T));
  return rows.map((r) => `${r.item}:${r.cat}`).sort();
};

test("import creates dishes and categories, updates by name, leaves the rest alone", async () => {
  const csv1 = "name,description,price,available,categories\nGreen Tea,Hot tea,4.00,yes,Drinks; Vegetarian\nFried Rice,,9.50,yes,Main\n";
  const p1 = await imp.previewMenuImport(csv1);
  assert.ok(p1.ok && p1.preview.creates === 2 && p1.preview.updates === 0 && p1.preview.newCategories.length === 3);
  assert.equal((await items()).length, 0, "preview changes nothing");

  const r1 = await imp.applyMenuImport(csv1);
  assert.deepEqual(r1, { ok: true, created: 2, updated: 0, unchanged: 0, newCategories: 3 });
  assert.deepEqual(await links(), ["Fried Rice:Main", "Green Tea:Drinks", "Green Tea:Vegetarian"]);
  const cats = await db.select().from(S.categories).where(eq(S.categories.tenantId, T)).orderBy(S.categories.sortOrder);
  assert.deepEqual(cats.map((c) => c.name), ["Drinks", "Vegetarian", "Main"], "new categories keep the file's order");

  // second file: only price+categories columns; match ignores case; Fried Rice not mentioned = untouched
  const [tea0] = (await items()).filter((i) => i.name === "Green Tea");
  const r2 = await imp.applyMenuImport("price,categories,name\n4.50,drinks,green tea\n3,Soup,Miso Soup\n");
  assert.deepEqual(r2, { ok: true, created: 1, updated: 1, unchanged: 0, newCategories: 1 });
  const all = await items();
  const tea = all.find((i) => i.name === "Green Tea")!;
  assert.equal(tea.id, tea0.id, "same dish, not a copy");
  assert.equal(tea.priceCents, 450);
  assert.equal(tea.description, "Hot tea", "a column that is not in the file is not touched");
  assert.equal(all.find((i) => i.name === "Fried Rice")!.priceCents, 950);
  assert.deepEqual(await links(), ["Fried Rice:Main", "Green Tea:Drinks", "Miso Soup:Soup"], "categories column replaces the dish's set");

  // a column that IS in the file clears when empty; same file again = unchanged
  const csv3 = "name,price,description,available\nGreen Tea,4.50,,no\n";
  assert.deepEqual(await imp.applyMenuImport(csv3), { ok: true, created: 0, updated: 1, unchanged: 0, newCategories: 0 });
  const tea3 = (await items()).find((i) => i.name === "Green Tea")!;
  assert.equal(tea3.description, null);
  assert.equal(tea3.available, false);
  assert.deepEqual(await imp.applyMenuImport(csv3), { ok: true, created: 0, updated: 0, unchanged: 1, newCategories: 0 });

  const log = await db.select({ action: S.auditLogs.action }).from(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  assert.equal(log.filter((l) => l.action === "menu.imported").length, 3, "one audit entry per import that changed something");
});

test("a file with any error changes nothing; ambiguous names are refused", async () => {
  const before = await items();
  const bad = await imp.applyMenuImport("name,price\nNew Dish,5\nBroken,abc\n");
  assert.equal(bad.ok, false);
  assert.equal((await items()).length, before.length, "the good row was not imported either");
  const p = await imp.previewMenuImport("name,price\nNew Dish,5\nBroken,abc\n");
  assert.ok(p.ok && p.preview.errors.length === 1 && p.preview.errors[0].line === 3);

  await db.insert(S.menuItems).values([{ tenantId: T, name: "Twin", priceCents: 100 }, { tenantId: T, name: "twin", priceCents: 200 }]);
  const amb = await imp.previewMenuImport("name,price\nTWIN,5\n");
  assert.ok(amb.ok && /share this name/.test(amb.preview.errors[0].message));
  assert.equal((await imp.applyMenuImport("name,price\nTWIN,5\n")).ok, false);
});

test("only the owner can import; another restaurant's dishes are never matched", async () => {
  await db.insert(S.menuItems).values({ tenantId: OTHER, name: "Other Dish", priceCents: 700 });
  const r = await imp.applyMenuImport("name,price\nOther Dish,1\n");
  assert.ok(r.ok && r.created === 1, "same name in another restaurant is a NEW dish here");
  const [theirs] = await db.select().from(S.menuItems).where(eq(S.menuItems.tenantId, OTHER));
  assert.equal(theirs.priceCents, 700);

  role = "member";
  const before = (await items()).length;
  assert.equal((await imp.applyMenuImport("name,price\nStaff Dish,1\n")).ok, false);
  assert.equal((await imp.previewMenuImport("name,price\nStaff Dish,1\n")).ok, false);
  assert.equal((await items()).length, before);
  role = "owner";
});
