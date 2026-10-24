import { asc, eq, sql } from "drizzle-orm";
import { Suspense } from "react";
import { menuItemModifierGroups, modifierGroups, modifierOptions } from "@/db/schema";
import { isOwner } from "@/lib/role-utils";
import { requireTenant } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant-db";
import { ModifierEditor, type GroupView } from "./modifier-editor";

async function ModifiersContent() {
  const { tenantId, role } = await requireTenant();
  if (!isOwner(role)) return <p className="text-muted-foreground">Only the restaurant owner can manage modifiers.</p>;
  // As THIS restaurant inside the database (row-level security), on top of the explicit filters.
  const { groups, options } = await withTenant(tenantId, async (db) => {
    const groups = await db
      .select({
        id: modifierGroups.id,
        name: modifierGroups.name,
        required: modifierGroups.required,
        maxSelect: modifierGroups.maxSelect,
        itemCount: sql<number>`(select count(*)::int from ${menuItemModifierGroups} where ${menuItemModifierGroups.groupId} = ${modifierGroups.id})`,
      })
      .from(modifierGroups)
      .where(eq(modifierGroups.tenantId, tenantId))
      .orderBy(asc(modifierGroups.sortOrder), asc(modifierGroups.name));
    const options = await db
      .select()
      .from(modifierOptions)
      .where(eq(modifierOptions.tenantId, tenantId))
      .orderBy(asc(modifierOptions.sortOrder), asc(modifierOptions.name));

    return { groups, options };
  });

  const view: GroupView[] = groups.map((g) => ({
    ...g,
    options: options
      .filter((o) => o.groupId === g.id)
      .map((o) => ({
        id: o.id,
        name: o.name,
        priceDeltaCents: o.priceDeltaCents,
        available: o.available,
      })),
  }));
  return <ModifierEditor groups={view} />;
}

export default function ModifiersPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <ModifiersContent />
    </Suspense>
  );
}
