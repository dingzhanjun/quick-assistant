import { asc, eq } from "drizzle-orm";
import type { db as Db } from "@/db";
import { categories, menuItemCategories, menuItemModifierGroups, menuItems, modifierGroups, modifierOptions } from "@/db/schema";

type Q = Pick<typeof Db, "select">;

// A restaurant's whole menu as plain data, with every link written by NAME (ids differ between restaurants).
export type MenuSnapshot = {
  categories: { name: string }[]; // in the restaurant's order
  groups: {
    name: string; required: boolean; maxSelect: number;
    options: { name: string; priceDeltaCents: number; available: boolean }[];
  }[];
  items: {
    name: string; description: string | null; priceCents: number; available: boolean;
    categoryNames: string[]; groupNames: string[];
  }[];
};

export type CopyMode = "add" | "update"; // add: only what is missing; update: also bring existing dishes / groups in line (by name)

const lc = (s: string) => s.trim().toLowerCase();

export async function readMenuSnapshot(q: Q, tenantId: string): Promise<MenuSnapshot> {
  const [cats, groups, options, items, itemCats, itemGroups] = await Promise.all([
    q.select().from(categories).where(eq(categories.tenantId, tenantId)).orderBy(asc(categories.sortOrder), asc(categories.name)),
    q.select().from(modifierGroups).where(eq(modifierGroups.tenantId, tenantId)).orderBy(asc(modifierGroups.sortOrder), asc(modifierGroups.name)),
    q.select().from(modifierOptions).where(eq(modifierOptions.tenantId, tenantId)).orderBy(asc(modifierOptions.sortOrder), asc(modifierOptions.name)),
    q.select().from(menuItems).where(eq(menuItems.tenantId, tenantId)).orderBy(asc(menuItems.name)),
    q.select({ itemId: menuItemCategories.menuItemId, categoryId: menuItemCategories.categoryId }).from(menuItemCategories).innerJoin(menuItems, eq(menuItems.id, menuItemCategories.menuItemId)).where(eq(menuItems.tenantId, tenantId)),
    q.select({ itemId: menuItemModifierGroups.menuItemId, groupId: menuItemModifierGroups.groupId, sort: menuItemModifierGroups.sortOrder }).from(menuItemModifierGroups).innerJoin(menuItems, eq(menuItems.id, menuItemModifierGroups.menuItemId)).where(eq(menuItems.tenantId, tenantId)).orderBy(asc(menuItemModifierGroups.sortOrder)),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  return {
    categories: cats.map((c) => ({ name: c.name })),
    groups: groups.map((g) => ({
      name: g.name, required: g.required, maxSelect: g.maxSelect,
      options: options.filter((o) => o.groupId === g.id).map((o) => ({ name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available })),
    })),
    items: items.map((i) => ({
      name: i.name, description: i.description, priceCents: i.priceCents, available: i.available,
      categoryNames: itemCats.filter((l) => l.itemId === i.id).map((l) => catName.get(l.categoryId)!).filter(Boolean),
      groupNames: itemGroups.filter((l) => l.itemId === i.id).map((l) => groupName.get(l.groupId)!).filter(Boolean),
    })),
  };
}

export type CopyPlan = {
  newItems: string[];
  updatedItems: { name: string; changes: string[] }[];
  unchangedItems: number;
  newCategories: string[];
  newGroups: string[];
  updatedGroups: string[]; // update mode: existing groups that get new / changed options
  ambiguous: string[]; // dishes in the destination that share a name (left alone)
};

// What copying `source` into `dest` would do. Matching is by name, ignoring case. Nothing is ever deleted; links (category,
// modifier group) are only ever ADDED. In "add" mode existing dishes, categories and groups are left exactly as they are.
export function planMenuCopy(source: MenuSnapshot, dest: MenuSnapshot, mode: CopyMode): CopyPlan {
  const plan: CopyPlan = { newItems: [], updatedItems: [], unchangedItems: 0, newCategories: [], newGroups: [], updatedGroups: [], ambiguous: [] };
  const destCats = new Set(dest.categories.map((c) => lc(c.name)));
  const destGroups = new Map(dest.groups.map((g) => [lc(g.name), g]));
  const byName = new Map<string, MenuSnapshot["items"]>();
  for (const i of dest.items) byName.set(lc(i.name), [...(byName.get(lc(i.name)) ?? []), i]);

  // Categories and modifier groups are copied whole (not only those the copied dishes use): a restaurant expects its lists to come along.
  for (const c of source.categories) if (!destCats.has(lc(c.name))) plan.newCategories.push(c.name);
  for (const g of source.groups) {
    const d = destGroups.get(lc(g.name));
    if (!d) plan.newGroups.push(g.name);
    else if (mode === "update") {
      const opts = new Map(d.options.map((o) => [lc(o.name), o]));
      const differs = g.options.some((o) => {
        const x = opts.get(lc(o.name));
        return !x || x.priceDeltaCents !== o.priceDeltaCents || x.available !== o.available;
      }) || d.required !== g.required || d.maxSelect !== g.maxSelect;
      if (differs) plan.updatedGroups.push(g.name);
    }
  }
  for (const i of source.items) {
    const matches = byName.get(lc(i.name)) ?? [];
    if (matches.length > 1) { plan.ambiguous.push(i.name); continue; }
    const cur = matches[0];
    if (!cur) { plan.newItems.push(i.name); continue; }
    if (mode === "add") { plan.unchangedItems++; continue; }
    const changes: string[] = [];
    if (cur.priceCents !== i.priceCents) changes.push("price");
    if ((cur.description ?? null) !== (i.description ?? null)) changes.push("description");
    if (cur.available !== i.available) changes.push("availability");
    const hasCats = new Set(cur.categoryNames.map(lc)), hasGroups = new Set(cur.groupNames.map(lc));
    if (i.categoryNames.some((n) => !hasCats.has(lc(n)))) changes.push("categories");
    if (i.groupNames.some((n) => !hasGroups.has(lc(n)))) changes.push("modifiers");
    if (changes.length) plan.updatedItems.push({ name: cur.name, changes }); else plan.unchangedItems++;
  }
  return plan;
}
