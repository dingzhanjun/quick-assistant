import { eq } from "drizzle-orm";
import type { db as Db } from "@/db";
import { categories, menuItemCategories, menuItems } from "@/db/schema";
import type { ImportError, ImportRow, ParsedImport } from "./menu-csv";

type Q = Pick<typeof Db, "select">;

export type PlanRow = {
  line: number;
  name: string;
  action: "create" | "update" | "unchanged";
  changes: string[]; // what an update changes, e.g. ["price", "categories"]
  itemId?: string; // existing dish
  row: ImportRow;
};
export type ImportPlan = { rows: PlanRow[]; newCategories: string[]; errors: ImportError[] };

const lc = (s: string) => s.trim().toLowerCase();

// Compares the parsed file with this restaurant's current menu. Dishes are matched by name (ignoring case); only the
// columns present in the file are compared. Pure reads: preview and apply both call it (apply inside its transaction).
export async function planMenuImport(q: Q, tenantId: string, parsed: ParsedImport): Promise<ImportPlan> {
  const errors = [...parsed.errors];
  const [items, cats, links] = await Promise.all([
    q.select().from(menuItems).where(eq(menuItems.tenantId, tenantId)),
    q.select().from(categories).where(eq(categories.tenantId, tenantId)),
    q
      .select({ menuItemId: menuItemCategories.menuItemId, categoryId: menuItemCategories.categoryId })
      .from(menuItemCategories)
      .innerJoin(menuItems, eq(menuItems.id, menuItemCategories.menuItemId))
      .where(eq(menuItems.tenantId, tenantId)),
  ]);
  const byName = new Map<string, (typeof items)[number][]>();
  for (const i of items) byName.set(lc(i.name), [...(byName.get(lc(i.name)) ?? []), i]);
  const catById = new Map(cats.map((c) => [c.id, c.name]));
  const catsOf = (itemId: string) => new Set(links.filter((l) => l.menuItemId === itemId).map((l) => lc(catById.get(l.categoryId) ?? "")));

  const rows: PlanRow[] = [];
  const known = new Set(cats.map((c) => lc(c.name)));
  const newCategories: string[] = [];
  for (const row of parsed.rows) {
    const matches = byName.get(lc(row.name)) ?? [];
    if (matches.length > 1) {
      errors.push({ line: row.line, message: `"${row.name}": ${matches.length} dishes on the menu already share this name; rename one first` });
      continue;
    }
    for (const c of row.categories ?? []) {
      if (!known.has(lc(c))) { known.add(lc(c)); newCategories.push(c); }
    }
    const cur = matches[0];
    if (!cur) { rows.push({ line: row.line, name: row.name, action: "create", changes: [], row }); continue; }
    const changes: string[] = [];
    if (row.description !== undefined && (cur.description ?? "") !== row.description) changes.push("description");
    if (cur.priceCents !== row.priceCents) changes.push("price");
    if (row.available !== undefined && cur.available !== row.available) changes.push("availability");
    if (row.categories !== undefined) {
      const had = catsOf(cur.id), want = new Set(row.categories.map(lc));
      if (had.size !== want.size || [...want].some((c) => !had.has(c))) changes.push("categories");
    }
    rows.push({ line: row.line, name: cur.name, action: changes.length ? "update" : "unchanged", changes, itemId: cur.id, row });
  }
  errors.sort((a, b) => a.line - b.line);
  return { rows, newCategories, errors };
}
