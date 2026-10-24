"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { menuItemCategories, menuItemModifierGroups, menuItems } from "@/db/schema";
import { tenantCategoryIds } from "@/lib/categories";
import { invalidateMenu } from "@/lib/menu-cache";
import { withTenant } from "@/lib/tenant-db";
import { audit, changes, userActor } from "@/lib/audit";
import { tenantGroupIds } from "@/lib/modifiers";
import { FORBIDDEN, requireOwner } from "@/lib/roles";
import { requireTenant } from "@/lib/tenant";

const itemSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.string().trim().max(1000).optional(),
  priceCents: z.number().int().min(0).max(10_000_00),
  available: z.boolean(),
  // Modifier groups (e.g. "Spice level") that apply to this item
  groupIds: z.array(z.string().uuid()).max(30).default([]),
  // Categories (e.g. "Drinks") the item belongs to; may be several
  categoryIds: z.array(z.string().uuid()).max(50).default([]),
});

export type ItemInput = z.input<typeof itemSchema>;
export type ActionResult = { ok: true } | { ok: false; error: string };

function fail(e: z.ZodError): ActionResult {
  return { ok: false, error: e.issues[0]?.message ?? "Invalid input" };
}

export async function saveMenuItem(id: string | null, input: ItemInput): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const parsed = itemSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error);
  const { groupIds, categoryIds, ...fields } = parsed.data;
  const values = { ...fields, description: fields.description || null };
  // Everything below runs as THIS restaurant inside the database (row-level security), on top of the explicit
  // tenant filters: a mistake in one cannot leak or change another restaurant's data.
  const { validGroupIds, validCategoryIds, categoriesBefore, before, createdId, result } = await withTenant(tenantId, async (db) => {
    // Only groups that belong to this restaurant can be attached.
    const validGroupIds = await tenantGroupIds(tenantId, groupIds, db);
    const validCategoryIds = await tenantCategoryIds(tenantId, categoryIds, db);
    const categoriesBefore = id
      ? (await db.select({ id: menuItemCategories.categoryId }).from(menuItemCategories).where(eq(menuItemCategories.menuItemId, id))).map((r) => r.id).sort()
      : [];
    const [before] = id
      ? await db.select().from(menuItems).where(and(eq(menuItems.id, id), eq(menuItems.tenantId, tenantId)))
      : [];
    let createdId: string | null = null;
    const result = await db.transaction(async (tx) => {
      let itemId = id;
      if (itemId) {
        // Scoped by tenant so one restaurant can never edit another's items.
        const updated = await tx
          .update(menuItems)
          .set(values)
          .where(and(eq(menuItems.id, itemId), eq(menuItems.tenantId, tenantId)))
          .returning({ id: menuItems.id });
        if (!updated.length) return { ok: false as const, error: "Item not found" };
      } else {
        const [created] = await tx
          .insert(menuItems)
          .values({ ...values, tenantId })
          .returning({ id: menuItems.id });
        itemId = created.id;
        createdId = created.id;
      }
      // Replace the item's group links with the chosen set.
      await tx.delete(menuItemModifierGroups).where(eq(menuItemModifierGroups.menuItemId, itemId));
      if (validGroupIds.length) {
        await tx.insert(menuItemModifierGroups).values(
          validGroupIds.map((groupId, sortOrder) => ({ menuItemId: itemId, groupId, sortOrder })),
        );
      }
      // Same for the categories.
      await tx.delete(menuItemCategories).where(eq(menuItemCategories.menuItemId, itemId));
      if (validCategoryIds.length) {
        await tx.insert(menuItemCategories).values(validCategoryIds.map((categoryId) => ({ menuItemId: itemId, categoryId })));
      }
      return { ok: true as const };
    });
    return { validGroupIds, validCategoryIds, categoriesBefore, before, createdId, result };
  });

  if (result.ok) {
    const actor = userActor(user);
    if (createdId) {
      await audit({
        action: "menu_item.created", actor, tenantId, entityType: "menu_item", entityId: createdId,
        summary: `Added menu item "${values.name}" ($${(values.priceCents / 100).toFixed(2)})`,
        details: { ...values, groupIds: validGroupIds, categoryIds: validCategoryIds },
      });
    } else if (before) {
      const diff: Record<string, [unknown, unknown]> = changes(before, { ...values });
      if (JSON.stringify(categoriesBefore) !== JSON.stringify([...validCategoryIds].sort())) {
        diff.categoryIds = [categoriesBefore, [...validCategoryIds].sort()];
      }
      if (Object.keys(diff).length) {
        await audit({
          action: "menu_item.updated", actor, tenantId, entityType: "menu_item", entityId: id,
          summary: `Edited menu item "${before.name}": ${Object.keys(diff).join(", ")}`,
          details: { changes: diff },
        });
      }
    }
  }
  invalidateMenu(tenantId);
  revalidatePath("/dashboard/menu");
  return result;
}

export async function setAvailability(id: string, available: boolean): Promise<ActionResult> {
  const { tenantId, user } = await requireTenant();
  const [row] = await withTenant(tenantId, (db) =>
    db
      .update(menuItems)
      .set({ available })
      .where(and(eq(menuItems.id, id), eq(menuItems.tenantId, tenantId)))
      .returning({ name: menuItems.name }),
  );
  if (row) {
    await audit({
      action: "menu_item.availability_changed", actor: userActor(user), tenantId, entityType: "menu_item", entityId: id,
      summary: `"${row.name}" marked ${available ? "available" : "sold out"}`, details: { available },
    });
  }
  invalidateMenu(tenantId);
  revalidatePath("/dashboard/menu");
  return { ok: true };
}

export async function deleteMenuItem(id: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const [row] = await withTenant(tenantId, (db) =>
    db
      .delete(menuItems)
      .where(and(eq(menuItems.id, id), eq(menuItems.tenantId, tenantId)))
      .returning({ name: menuItems.name, priceCents: menuItems.priceCents }),
  );
  if (row) {
    await audit({
      action: "menu_item.deleted", actor: userActor(user), tenantId, entityType: "menu_item", entityId: id,
      summary: `Deleted menu item "${row.name}"`, details: { name: row.name, priceCents: row.priceCents },
    });
  }
  invalidateMenu(tenantId);
  revalidatePath("/dashboard/menu");
  return { ok: true };
}
