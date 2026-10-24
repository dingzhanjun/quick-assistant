"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { categories, member, menuItemCategories, menuItemModifierGroups, menuItems, modifierGroups, modifierOptions, organization } from "@/db/schema";
import { audit, userActor } from "@/lib/audit";
import { invalidateMenu } from "@/lib/menu-cache";
import { type CopyMode, type CopyPlan, planMenuCopy, readMenuSnapshot } from "@/lib/menu-copy";
import { FORBIDDEN, requireOwner } from "@/lib/roles";
import { withTenant } from "@/lib/tenant-db";

const lc = (s: string) => s.trim().toLowerCase();
type Fail = { ok: false; error: string };

// The restaurant to copy FROM: another one that THIS user also owns (nobody can read a menu they do not own).
async function checkSource(sourceId: string, mode: string) {
  const owner = await requireOwner();
  if (!owner) return FORBIDDEN;
  if (mode !== "add" && mode !== "update") return { ok: false, error: "Unknown copy mode" } as Fail;
  if (!sourceId || sourceId === owner.tenantId) return { ok: false, error: "Choose another restaurant" } as Fail;
  const [m] = await db
    .select({ role: member.role, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, owner.user.id), eq(member.organizationId, sourceId)));
  if (!m || m.role !== "owner") return { ok: false, error: "You can only copy from a restaurant you own" } as Fail;
  return { ok: true as const, owner, sourceName: m.name, mode: mode as CopyMode };
}

export type CopyPreview = { ok: true; sourceName: string; plan: CopyPlan } | Fail;

// Dry run: what copying would do. Changes nothing.
export async function previewMenuCopy(sourceId: string, mode: string): Promise<CopyPreview> {
  const c = await checkSource(sourceId, mode);
  if (!c.ok) return c;
  const [source, dest] = await Promise.all([
    withTenant(sourceId, (q) => readMenuSnapshot(q, sourceId)),
    withTenant(c.owner.tenantId, (q) => readMenuSnapshot(q, c.owner.tenantId)),
  ]);
  return { ok: true, sourceName: c.sourceName, plan: planMenuCopy(source, dest, c.mode) };
}

export type CopyResult = { ok: true; created: number; updated: number; categories: number; groups: number } | Fail;

// Copies the whole menu (dishes, categories, modifier groups with their options, and the links between them) from the other
// restaurant into this one, in ONE transaction. Dishes and groups are matched by name; nothing is ever deleted.
export async function applyMenuCopy(sourceId: string, mode: string): Promise<CopyResult> {
  const c = await checkSource(sourceId, mode);
  if (!c.ok) return c;
  const { tenantId, user } = c.owner;
  const source = await withTenant(sourceId, (q) => readMenuSnapshot(q, sourceId));

  const plan = await withTenant(tenantId, (db) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}))`); // two copies at once cannot both create the same dish
      const dest = await readMenuSnapshot(tx, tenantId);
      const plan = planMenuCopy(source, dest, c.mode);
      const update = c.mode === "update";

      // categories
      const catRows = await tx.select().from(categories).where(eq(categories.tenantId, tenantId));
      const catId = new Map(catRows.map((r) => [lc(r.name), r.id]));
      let nextCat = catRows.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
      for (const sc of source.categories) {
        const id = catId.get(lc(sc.name));
        if (!id) {
          const [made] = await tx.insert(categories).values({ tenantId, name: sc.name, sortOrder: nextCat++ }).returning({ id: categories.id });
          catId.set(lc(sc.name), made.id);
        }
      }

      // modifier groups and their options
      const groupRows = await tx.select().from(modifierGroups).where(eq(modifierGroups.tenantId, tenantId));
      const groupId = new Map(groupRows.map((r) => [lc(r.name), r.id]));
      let nextGroup = groupRows.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
      for (const sg of source.groups) {
        let id = groupId.get(lc(sg.name));
        if (!id) {
          const [made] = await tx.insert(modifierGroups).values({ tenantId, name: sg.name, required: sg.required, maxSelect: sg.maxSelect, sortOrder: nextGroup++ }).returning({ id: modifierGroups.id });
          id = made.id;
          groupId.set(lc(sg.name), id);
          if (sg.options.length) await tx.insert(modifierOptions).values(sg.options.map((o, i) => ({ tenantId, groupId: id!, name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available, sortOrder: i })));
        } else if (update) {
          await tx.update(modifierGroups).set({ required: sg.required, maxSelect: sg.maxSelect }).where(and(eq(modifierGroups.id, id), eq(modifierGroups.tenantId, tenantId)));
          const opts = await tx.select().from(modifierOptions).where(and(eq(modifierOptions.groupId, id), eq(modifierOptions.tenantId, tenantId)));
          const byName = new Map(opts.map((o) => [lc(o.name), o]));
          let nextOpt = opts.reduce((m, o) => Math.max(m, o.sortOrder), -1) + 1;
          for (const so of sg.options) {
            const cur = byName.get(lc(so.name));
            if (!cur) await tx.insert(modifierOptions).values({ tenantId, groupId: id, name: so.name, priceDeltaCents: so.priceDeltaCents, available: so.available, sortOrder: nextOpt++ });
            else await tx.update(modifierOptions).set({ priceDeltaCents: so.priceDeltaCents, available: so.available }).where(and(eq(modifierOptions.id, cur.id), eq(modifierOptions.tenantId, tenantId)));
          }
        }
      }

      // dishes and their links (links are only ever added)
      const itemRows = await tx.select().from(menuItems).where(eq(menuItems.tenantId, tenantId));
      const byName = new Map<string, typeof itemRows>();
      for (const r of itemRows) byName.set(lc(r.name), [...(byName.get(lc(r.name)) ?? []), r]);
      for (const si of source.items) {
        const matches = byName.get(lc(si.name)) ?? [];
        if (matches.length > 1) continue; // ambiguous: reported in the plan, left alone
        let id: string;
        if (!matches[0]) {
          const [made] = await tx.insert(menuItems).values({ tenantId, name: si.name, description: si.description, priceCents: si.priceCents, available: si.available }).returning({ id: menuItems.id });
          id = made.id;
        } else if (update) {
          id = matches[0].id;
          await tx.update(menuItems).set({ description: si.description, priceCents: si.priceCents, available: si.available }).where(and(eq(menuItems.id, id), eq(menuItems.tenantId, tenantId)));
        } else continue;
        const catLinks = [...new Set(si.categoryNames.map((n) => catId.get(lc(n))).filter((x): x is string => !!x))];
        if (catLinks.length) await tx.insert(menuItemCategories).values(catLinks.map((categoryId) => ({ menuItemId: id, categoryId }))).onConflictDoNothing();
        const grpLinks = [...new Set(si.groupNames.map((n) => groupId.get(lc(n))).filter((x): x is string => !!x))];
        if (grpLinks.length) await tx.insert(menuItemModifierGroups).values(grpLinks.map((gid, sortOrder) => ({ menuItemId: id, groupId: gid, sortOrder }))).onConflictDoNothing();
      }
      return plan;
    }),
  );

  const created = plan.newItems.length, updated = plan.updatedItems.length;
  if (created || updated || plan.newCategories.length || plan.newGroups.length || plan.updatedGroups.length) {
    await audit({
      action: "menu.copied", actor: userActor(user), tenantId, entityType: "menu", entityId: sourceId,
      summary: `Menu copied from "${c.sourceName}": ${created} dishes added, ${updated} updated, ${plan.newCategories.length} categories and ${plan.newGroups.length} modifier groups added`,
      details: { sourceId, mode: c.mode, newItems: plan.newItems.slice(0, 100), updatedItems: plan.updatedItems.slice(0, 100), newCategories: plan.newCategories, newGroups: plan.newGroups, updatedGroups: plan.updatedGroups },
    });
  }
  invalidateMenu(tenantId);
  for (const path of ["/dashboard/menu", "/dashboard/categories", "/dashboard/modifiers"]) revalidatePath(path);
  return { ok: true, created, updated, categories: plan.newCategories.length, groups: plan.newGroups.length };
}
