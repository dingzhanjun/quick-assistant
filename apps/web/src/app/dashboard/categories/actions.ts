"use server";

import { and, asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { categories } from "@/db/schema";
import { audit, changes, userActor } from "@/lib/audit";
import { invalidateMenu } from "@/lib/menu-cache";
import { FORBIDDEN, requireOwner } from "@/lib/roles";
import { withTenant } from "@/lib/tenant-db";

const categorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required").max(100),
});

export type CategoryInput = z.input<typeof categorySchema>;
export type ActionResult = { ok: true } | { ok: false; error: string };

function refresh(tenantId: string) {
  invalidateMenu(tenantId);
  revalidatePath("/dashboard/categories");
  revalidatePath("/dashboard/menu");
}

export async function saveCategory(id: string | null, input: CategoryInput): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const values = { name: parsed.data.name };

  const { before, createdId, result } = await withTenant(tenantId, async (db) => {
    const clash = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.tenantId, tenantId), sql`lower(${categories.name}) = lower(${values.name})`));
    if (clash.some((c) => c.id !== id)) {
      return { before: undefined, createdId: null, result: { ok: false as const, error: "A category with that name already exists" } };
    }
    if (id) {
      const [before] = await db.select().from(categories).where(and(eq(categories.id, id), eq(categories.tenantId, tenantId)));
      // Scoped by tenant so one restaurant can never edit another's category.
      const updated = await db
        .update(categories)
        .set(values)
        .where(and(eq(categories.id, id), eq(categories.tenantId, tenantId)))
        .returning({ id: categories.id });
      if (!updated.length) return { before, createdId: null, result: { ok: false as const, error: "Category not found" } };
      return { before, createdId: null, result: { ok: true as const } };
    }
    const [{ next }] = await db
      .select({ next: sql<number>`coalesce(max(${categories.sortOrder}), -1) + 1` })
      .from(categories)
      .where(eq(categories.tenantId, tenantId));
    const [created] = await db.insert(categories).values({ ...values, tenantId, sortOrder: next }).returning({ id: categories.id });
    return { before: undefined, createdId: created.id, result: { ok: true as const } };
  });

  if (result.ok) {
    const actor = userActor(user);
    if (createdId) {
      await audit({
        action: "category.created", actor, tenantId, entityType: "category", entityId: createdId,
        summary: `Added category "${values.name}"`, details: values,
      });
    } else if (before) {
      const diff = changes(before, values);
      if (Object.keys(diff).length) {
        await audit({
          action: "category.updated", actor, tenantId, entityType: "category", entityId: id,
          summary: `Edited category "${before.name}": ${Object.keys(diff).join(", ")}`, details: { changes: diff },
        });
      }
    }
    refresh(tenantId);
  }
  return result;
}

export async function deleteCategory(id: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  // The dishes stay; only their link to this category goes (cascade).
  const [row] = await withTenant(tenantId, (db) =>
    db.delete(categories).where(and(eq(categories.id, id), eq(categories.tenantId, tenantId))).returning({ name: categories.name }),
  );
  if (row) {
    await audit({
      action: "category.deleted", actor: userActor(user), tenantId, entityType: "category", entityId: id,
      summary: `Deleted category "${row.name}"`,
    });
  }
  refresh(tenantId);
  return { ok: true };
}

// Swap a category with its neighbour in the list (up = earlier).
export async function moveCategory(id: string, direction: "up" | "down"): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const moved = await withTenant(tenantId, async (db) =>
    db.transaction(async (tx) => {
      const list = await tx
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(eq(categories.tenantId, tenantId))
        .orderBy(asc(categories.sortOrder), asc(categories.name));
      const from = list.findIndex((c) => c.id === id);
      const to = direction === "up" ? from - 1 : from + 1;
      if (from < 0 || to < 0 || to >= list.length) return null;
      [list[from], list[to]] = [list[to], list[from]];
      // Rewrite the whole order so equal sort values (from older rows) cannot make the swap a no-op.
      for (const [sortOrder, c] of list.entries()) {
        await tx.update(categories).set({ sortOrder }).where(and(eq(categories.id, c.id), eq(categories.tenantId, tenantId)));
      }
      return list[to].name;
    }),
  );
  if (moved) {
    await audit({
      action: "category.reordered", actor: userActor(user), tenantId, entityType: "category", entityId: id,
      summary: `Moved category "${moved}" ${direction}`,
    });
  }
  refresh(tenantId);
  return { ok: true };
}
