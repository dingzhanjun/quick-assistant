"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { categories, menuItemCategories, menuItems } from "@/db/schema";
import { audit, userActor } from "@/lib/audit";
import { invalidateMenu } from "@/lib/menu-cache";
import { parseMenuCsv } from "@/lib/menu-csv";
import { planMenuImport } from "@/lib/menu-import";
import { FORBIDDEN, requireOwner } from "@/lib/roles";
import { withTenant } from "@/lib/tenant-db";

export type ImportPreview = {
  creates: number;
  updates: number;
  unchanged: number;
  newCategories: string[];
  // first rows, for the preview table
  rows: { line: number; name: string; action: "create" | "update" | "unchanged"; changes: string[] }[];
  errors: { line: number; message: string }[];
};

export type PreviewResult = { ok: true; preview: ImportPreview } | { ok: false; error: string };
export type ImportResult = { ok: true; created: number; updated: number; unchanged: number; newCategories: number } | { ok: false; error: string };

// Dry run: what importing this CSV would do. Changes nothing.
export async function previewMenuImport(csv: string): Promise<PreviewResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  if (typeof csv !== "string") return { ok: false, error: "Invalid file" };
  const plan = await withTenant(owner.tenantId, (db) => planMenuImport(db, owner.tenantId, parseMenuCsv(csv)));
  const count = (a: string) => plan.rows.filter((r) => r.action === a).length;
  return {
    ok: true,
    preview: {
      creates: count("create"), updates: count("update"), unchanged: count("unchanged"),
      newCategories: plan.newCategories,
      rows: plan.rows.map(({ line, name, action, changes }) => ({ line, name, action, changes })),
      errors: plan.errors,
    },
  };
}

// Creates new dishes, updates existing ones (matched by name) and creates missing categories, all in one
// transaction: either the whole file is applied or nothing is. A file with any error is refused as a whole.
export async function applyMenuImport(csv: string): Promise<ImportResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  if (typeof csv !== "string") return { ok: false, error: "Invalid file" };
  const parsed = parseMenuCsv(csv);
  if (parsed.errors.length) return { ok: false, error: `Fix the ${parsed.errors.length} problem(s) in the file first` };

  const outcome = await withTenant(tenantId, (db) =>
    db.transaction(async (tx) => {
      const plan = await planMenuImport(tx, tenantId, parsed);
      if (plan.errors.length) return { error: plan.errors[0].message } as const;

      // categories that do not exist yet, appended after the current ones
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${categories.sortOrder}), -1) + 1` })
        .from(categories)
        .where(eq(categories.tenantId, tenantId));
      if (plan.newCategories.length) {
        await tx.insert(categories).values(plan.newCategories.map((name, i) => ({ tenantId, name, sortOrder: next + i })));
      }
      const cats = await tx.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.tenantId, tenantId));
      const catId = new Map(cats.map((c) => [c.name.trim().toLowerCase(), c.id]));

      for (const p of plan.rows) {
        if (p.action === "unchanged") continue;
        const r = p.row;
        let itemId = p.itemId;
        if (p.action === "create") {
          const [created] = await tx
            .insert(menuItems)
            .values({
              tenantId, name: r.name, description: r.description || null,
              priceCents: r.priceCents, available: r.available ?? true,
            })
            .returning({ id: menuItems.id });
          itemId = created.id;
        } else {
          await tx
            .update(menuItems)
            .set({
              priceCents: r.priceCents,
              ...(r.description !== undefined ? { description: r.description || null } : {}),
              ...(r.available !== undefined ? { available: r.available } : {}),
            })
            .where(and(eq(menuItems.id, itemId!), eq(menuItems.tenantId, tenantId)));
        }
        if (r.categories !== undefined && (p.action === "create" || p.changes.includes("categories"))) {
          await tx.delete(menuItemCategories).where(eq(menuItemCategories.menuItemId, itemId!));
          const ids = [...new Set(r.categories.map((c) => catId.get(c.toLowerCase())).filter((x): x is string => !!x))];
          if (ids.length) await tx.insert(menuItemCategories).values(ids.map((categoryId) => ({ menuItemId: itemId!, categoryId })));
        }
      }
      return { plan } as const;
    }),
  );
  if ("error" in outcome) return { ok: false, error: outcome.error ?? "Import failed" };

  const { plan } = outcome;
  const count = (a: string) => plan.rows.filter((r) => r.action === a).length;
  const result = { created: count("create"), updated: count("update"), unchanged: count("unchanged"), newCategories: plan.newCategories.length };
  if (result.created || result.updated || result.newCategories) {
    await audit({
      action: "menu.imported", actor: userActor(user), tenantId, entityType: "menu",
      summary: `Imported menu CSV: ${result.created} added, ${result.updated} updated, ${result.unchanged} unchanged, ${result.newCategories} new categories`,
      details: {
        ...result,
        added: plan.rows.filter((r) => r.action === "create").map((r) => r.name).slice(0, 100),
        updated: plan.rows.filter((r) => r.action === "update").map((r) => ({ name: r.name, changes: r.changes })).slice(0, 100),
        newCategories: plan.newCategories,
      },
    });
  }
  invalidateMenu(tenantId);
  revalidatePath("/dashboard/menu");
  revalidatePath("/dashboard/categories");
  return { ok: true, ...result };
}
