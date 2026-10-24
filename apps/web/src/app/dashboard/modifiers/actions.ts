"use server";

import { and, eq, notInArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { modifierGroups, modifierOptions } from "@/db/schema";
import { invalidateMenu } from "@/lib/menu-cache";
import { withTenant } from "@/lib/tenant-db";
import { audit, changes, userActor } from "@/lib/audit";
import { FORBIDDEN, requireOwner } from "@/lib/roles";

const optionSchema = z.object({
  id: z.string().uuid().optional(), // present = existing option being edited
  name: z.string().trim().min(1, "Every option needs a name").max(100),
  priceDeltaCents: z.number().int().min(-100_000).max(100_000),
  available: z.boolean(),
});

const groupSchema = z.object({
  name: z.string().trim().min(1, "Group name is required").max(100),
  required: z.boolean(),
  maxSelect: z.number().int().min(1).max(20),
  options: z.array(optionSchema).min(1, "Add at least one option").max(40),
});

export type GroupInput = z.input<typeof groupSchema>;
export type ActionResult = { ok: true } | { ok: false; error: string };

export async function saveModifierGroup(id: string | null, input: GroupInput): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  const parsed = groupSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { name, required, maxSelect, options } = parsed.data;
  if (required && maxSelect < 1) return { ok: false, error: "A required group must allow at least 1" };

  // Runs as THIS restaurant inside the database (row-level security) on top of the explicit tenant filters.
  const { before, optionsBefore, createdId, result } = await withTenant(tenantId, async (db) => {
    const [before] = id
      ? await db.select().from(modifierGroups).where(and(eq(modifierGroups.id, id), eq(modifierGroups.tenantId, tenantId)))
      : [];
    const optionsBefore = id
      ? await db.select({ id: modifierOptions.id, name: modifierOptions.name, priceDeltaCents: modifierOptions.priceDeltaCents, available: modifierOptions.available })
          .from(modifierOptions).where(and(eq(modifierOptions.groupId, id), eq(modifierOptions.tenantId, tenantId)))
      : [];
    let createdId: string | null = null;
    const result = await db.transaction(async (tx) => {
      let groupId = id;
      if (groupId) {
        // Scoped by tenant so one restaurant can never edit another's group.
        const updated = await tx
          .update(modifierGroups)
          .set({ name, required, maxSelect })
          .where(and(eq(modifierGroups.id, groupId), eq(modifierGroups.tenantId, tenantId)))
          .returning({ id: modifierGroups.id });
        if (!updated.length) return { ok: false as const, error: "Group not found" };
      } else {
        const [created] = await tx
          .insert(modifierGroups)
          .values({ tenantId, name, required, maxSelect })
          .returning({ id: modifierGroups.id });
        groupId = created.id;
        createdId = created.id;
      }

      // Sync options: drop the ones the editor removed, update the ones it kept, insert the new ones.
      const keepIds = options.flatMap((o) => (o.id ? [o.id] : []));
      await tx
        .delete(modifierOptions)
        .where(
          and(
            eq(modifierOptions.groupId, groupId),
            eq(modifierOptions.tenantId, tenantId),
            keepIds.length ? notInArray(modifierOptions.id, keepIds) : undefined,
          ),
        );
      for (const [sortOrder, o] of options.entries()) {
        if (o.id) {
          await tx
            .update(modifierOptions)
            .set({
              name: o.name,
              priceDeltaCents: o.priceDeltaCents,
              available: o.available,
              sortOrder,
            })
            .where(
              and(
                eq(modifierOptions.id, o.id),
                eq(modifierOptions.groupId, groupId),
                eq(modifierOptions.tenantId, tenantId),
              ),
            );
        } else {
          await tx.insert(modifierOptions).values({
            tenantId,
            groupId,
            name: o.name,
            priceDeltaCents: o.priceDeltaCents,
            available: o.available,
            sortOrder,
          });
        }
      }
      return { ok: true as const };
    });
    return { before, optionsBefore, createdId, result };
  });

  if (result.ok) {
    const actor = userActor(user);
    const optionSummary = options.map((o) => ({ name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available }));
    if (createdId) {
      await audit({
        action: "modifier_group.created", actor, tenantId, entityType: "modifier_group", entityId: createdId,
        summary: `Added modifier group "${name}" with ${options.length} option(s)`,
        details: { name, required, maxSelect, options: optionSummary },
      });
    } else if (before) {
      const diff = changes(before, { name, required, maxSelect });
      const optsChanged =
        JSON.stringify(optionsBefore.map(({ name, priceDeltaCents, available }) => ({ name, priceDeltaCents, available }))) !==
        JSON.stringify(optionSummary);
      if (Object.keys(diff).length || optsChanged) {
        await audit({
          action: "modifier_group.updated", actor, tenantId, entityType: "modifier_group", entityId: id,
          summary: `Edited modifier group "${before.name}"`,
          details: { changes: diff, ...(optsChanged ? { optionsBefore, optionsAfter: optionSummary } : {}) },
        });
      }
    }
  }
  invalidateMenu(tenantId);
  revalidatePath("/dashboard/modifiers");
  invalidateMenu(tenantId);
  revalidatePath("/dashboard/menu");
  return result;
}

export async function deleteModifierGroup(id: string): Promise<ActionResult> {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  const { tenantId, user } = owner;
  // Options and menu-item links cascade; past orders keep their own snapshot.
  const [row] = await withTenant(tenantId, (db) =>
    db
      .delete(modifierGroups)
      .where(and(eq(modifierGroups.id, id), eq(modifierGroups.tenantId, tenantId)))
      .returning({ name: modifierGroups.name }),
  );
  if (row) {
    await audit({
      action: "modifier_group.deleted", actor: userActor(user), tenantId, entityType: "modifier_group", entityId: id,
      summary: `Deleted modifier group "${row.name}"`,
    });
  }
  invalidateMenu(tenantId);
  revalidatePath("/dashboard/modifiers");
  invalidateMenu(tenantId);
  revalidatePath("/dashboard/menu");
  return { ok: true };
}
