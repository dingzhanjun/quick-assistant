import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { categoriesForItems, type CategoryRef } from "./categories";

// Where a query runs: the plain `db` (platform code) or the `tx` of withTenant() (row-secured to one restaurant).
type Q = Pick<typeof db, "select">;
import {
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifierOptions,
} from "@/db/schema";

export type ModifierOption = { id: string; name: string; priceDeltaCents: number };
export type ModifierGroup = {
  id: string;
  name: string;
  required: boolean;
  maxSelect: number;
  options: ModifierOption[];
};
export type MenuItemWithModifiers = {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  // Categories the dish is in ("Drinks", ...), `position` = the owner's category order; empty = uncategorised.
  categories: { name: string; position: number }[];
  modifierGroups: ModifierGroup[];
};
// optionId lets a later change-my-order call rebuild the cart; older orders were saved without it.
export type ModifierSnapshot = { group: string; option: string; priceDeltaCents: number; optionId?: string };

// The modifier groups (with their available options) attached to each of the given menu items.
export async function groupsForItems(
  tenantId: string,
  itemIds: string[],
  q: Q = db,
): Promise<Map<string, ModifierGroup[]>> {
  const result = new Map<string, ModifierGroup[]>(itemIds.map((id) => [id, []]));
  if (!itemIds.length) return result;

  const links = await q
    .select({
      menuItemId: menuItemModifierGroups.menuItemId,
      group: modifierGroups,
    })
    .from(menuItemModifierGroups)
    .innerJoin(modifierGroups, eq(modifierGroups.id, menuItemModifierGroups.groupId))
    .where(
      and(
        inArray(menuItemModifierGroups.menuItemId, itemIds),
        eq(modifierGroups.tenantId, tenantId),
      ),
    )
    .orderBy(asc(menuItemModifierGroups.sortOrder), asc(modifierGroups.sortOrder), asc(modifierGroups.name));
  if (!links.length) return result;

  const options = await q
    .select()
    .from(modifierOptions)
    .where(
      and(
        eq(modifierOptions.tenantId, tenantId),
        eq(modifierOptions.available, true),
        inArray(modifierOptions.groupId, [...new Set(links.map((l) => l.group.id))]),
      ),
    )
    .orderBy(asc(modifierOptions.sortOrder), asc(modifierOptions.name));

  const optionsByGroup = new Map<string, ModifierOption[]>();
  for (const o of options) {
    const list = optionsByGroup.get(o.groupId) ?? [];
    list.push({ id: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents });
    optionsByGroup.set(o.groupId, list);
  }
  for (const l of links) {
    // A group with no available options can't be chosen from, so it is left out entirely.
    const opts = optionsByGroup.get(l.group.id) ?? [];
    if (!opts.length) continue;
    result.get(l.menuItemId)!.push({
      id: l.group.id,
      name: l.group.name,
      required: l.group.required,
      maxSelect: l.group.maxSelect,
      options: opts,
    });
  }
  return result;
}

export async function availableMenuWithModifiers(tenantId: string, q: Q = db): Promise<MenuItemWithModifiers[]> {
  const items = await q
    .select({
      id: menuItems.id,
      name: menuItems.name,
      description: menuItems.description,
      priceCents: menuItems.priceCents,
    })
    .from(menuItems)
    .where(and(eq(menuItems.tenantId, tenantId), eq(menuItems.available, true)));
  const ids = items.map((i) => i.id);
  const groups = await groupsForItems(tenantId, ids, q);
  const cats = await categoriesForItems(tenantId, ids, q);
  return items.map((i) => ({
    ...i,
    categories: (cats.get(i.id) ?? []).map((c: CategoryRef) => ({ name: c.name, position: c.sortOrder })),
    modifierGroups: groups.get(i.id) ?? [],
  }));
}

// Validates the options a caller picked for one menu item against that item's groups and returns the
// snapshot to store, or an error message. Never trust ids from the agent: they must belong to a group
// attached to THIS item in THIS tenant, the group's limits must hold and required groups must be answered.
export function resolveSelection(
  groups: ModifierGroup[],
  optionIds: string[],
): { ok: true; snapshot: ModifierSnapshot[] } | { ok: false; error: string } {
  const wanted = [...new Set(optionIds)];
  const byOption = new Map<string, { group: ModifierGroup; option: ModifierOption }>();
  for (const g of groups) for (const o of g.options) byOption.set(o.id, { group: g, option: o });

  const unknown = wanted.filter((id) => !byOption.has(id));
  if (unknown.length) return { ok: false, error: `unknown or unavailable option ids: ${unknown.join(", ")}` };

  const perGroup = new Map<string, number>();
  const snapshot: ModifierSnapshot[] = [];
  for (const id of wanted) {
    const { group, option } = byOption.get(id)!;
    perGroup.set(group.id, (perGroup.get(group.id) ?? 0) + 1);
    snapshot.push({ group: group.name, option: option.name, priceDeltaCents: option.priceDeltaCents, optionId: option.id });
  }
  for (const g of groups) {
    const n = perGroup.get(g.id) ?? 0;
    if (g.required && n < 1) return { ok: false, error: `choose an option for "${g.name}"` };
    if (n > g.maxSelect) return { ok: false, error: `"${g.name}" allows at most ${g.maxSelect}` };
  }
  return { ok: true, snapshot };
}

export { lineUnitCents } from "./pricing";

// Keeps only the group ids that belong to this restaurant (used when attaching groups to a menu item).
export async function tenantGroupIds(tenantId: string, ids: string[], q: Q = db): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await q
    .select({ id: modifierGroups.id })
    .from(modifierGroups)
    .where(and(eq(modifierGroups.tenantId, tenantId), inArray(modifierGroups.id, ids)));
  return rows.map((r) => r.id);
}
