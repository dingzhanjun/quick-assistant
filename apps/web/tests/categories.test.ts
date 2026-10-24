// Categories: a dish can be in several, owners manage them, the agent menu carries them in the owner's order.
// Needs a migrated Postgres (DATABASE_URL); creates a throwaway restaurant and removes it afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";

const T = `cat-${randomUUID().slice(0, 8)}`;
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/tenant.ts"), {
  namedExports: { requireTenant: async () => ({ tenantId: T, role: "owner", user: { id: "u", email: "u@x" } }) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  await db.insert(S.organization).values({ id: T, name: "Cat test", slug: T, createdAt: new Date() });
});
after(async () => {
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  await db.delete(S.organization).where(eq(S.organization.id, T));
  process.exit(0);
});

test("categories: create, share a dish between two, reorder, delete", async () => {
  const cats = await import("../src/app/dashboard/categories/actions");
  const menu = await import("../src/app/dashboard/menu/actions");
  const { availableMenuWithModifiers } = await import("../src/lib/modifiers");

  assert.equal((await cats.saveCategory(null, { name: "Drinks" })).ok, true);
  assert.equal((await cats.saveCategory(null, { name: "Vegetarian" })).ok, true);
  const dup = await cats.saveCategory(null, { name: "drinks" });
  assert.equal(dup.ok, false, "names are unique per restaurant, ignoring case");
  assert.equal((await cats.saveCategory(null, { name: "  " })).ok, false);

  const list = () => db.select().from(S.categories).where(eq(S.categories.tenantId, T)).orderBy(S.categories.sortOrder);
  const [drinks, veg] = await list();
  assert.deepEqual([drinks.name, veg.name], ["Drinks", "Vegetarian"]);

  // one dish in both categories, one in none
  assert.equal((await menu.saveMenuItem(null, { name: "Green tea", priceCents: 400, available: true, categoryIds: [veg.id, drinks.id] })).ok, true);
  assert.equal((await menu.saveMenuItem(null, { name: "Plain rice", priceCents: 300, available: true })).ok, true);

  let items = await availableMenuWithModifiers(T);
  const tea = items.find((i) => i.name === "Green tea")!;
  assert.deepEqual(tea.categories.map((c) => c.name), ["Drinks", "Vegetarian"], "listed in the owner's category order");
  assert.deepEqual(items.find((i) => i.name === "Plain rice")!.categories, []);

  // moving Vegetarian up puts it first for the dish too
  await cats.moveCategory(veg.id, "up");
  items = await availableMenuWithModifiers(T);
  assert.deepEqual(items.find((i) => i.name === "Green tea")!.categories.map((c) => c.name), ["Vegetarian", "Drinks"]);
  await cats.moveCategory(veg.id, "up"); // already first: no-op, no error

  // editing the dish with a different set replaces the links
  const [teaRow] = await db.select().from(S.menuItems).where(and(eq(S.menuItems.tenantId, T), eq(S.menuItems.name, "Green tea")));
  await menu.saveMenuItem(teaRow.id, { name: "Green tea", priceCents: 400, available: true, categoryIds: [drinks.id] });
  items = await availableMenuWithModifiers(T);
  assert.deepEqual(items.find((i) => i.name === "Green tea")!.categories.map((c) => c.name), ["Drinks"]);

  // deleting a category keeps the dish
  assert.equal((await cats.deleteCategory(drinks.id)).ok, true);
  items = await availableMenuWithModifiers(T);
  assert.deepEqual(items.find((i) => i.name === "Green tea")!.categories, []);
  assert.equal(items.length, 2);

  const logged = await db.select({ action: S.auditLogs.action }).from(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  const actions = new Set(logged.map((l) => l.action));
  for (const a of ["category.created", "category.reordered", "category.deleted", "menu_item.updated"]) assert.ok(actions.has(a), `audited: ${a}`);
});
