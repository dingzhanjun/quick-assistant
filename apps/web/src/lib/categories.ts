import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { categories, menuItemCategories } from "@/db/schema";

// Where a query runs: the plain `db` (platform code) or the `tx` of withTenant() (row-secured to one restaurant).
type Q = Pick<typeof db, "select">;

export type CategoryRef = { id: string; name: string; sortOrder: number };

// The categories of each of the given menu items, in the restaurant's category order.
export async function categoriesForItems(tenantId: string, itemIds: string[], q: Q = db): Promise<Map<string, CategoryRef[]>> {
  const result = new Map<string, CategoryRef[]>(itemIds.map((id) => [id, []]));
  if (!itemIds.length) return result;
  const rows = await q
    .select({ menuItemId: menuItemCategories.menuItemId, id: categories.id, name: categories.name, sortOrder: categories.sortOrder })
    .from(menuItemCategories)
    .innerJoin(categories, eq(categories.id, menuItemCategories.categoryId))
    .where(and(eq(categories.tenantId, tenantId), inArray(menuItemCategories.menuItemId, itemIds)))
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  for (const r of rows) result.get(r.menuItemId)!.push({ id: r.id, name: r.name, sortOrder: r.sortOrder });
  return result;
}

// Keeps only the category ids that belong to this restaurant (used when putting a dish in categories).
export async function tenantCategoryIds(tenantId: string, ids: string[], q: Q = db): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await q
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.tenantId, tenantId), inArray(categories.id, ids)));
  return rows.map((r) => r.id);
}
