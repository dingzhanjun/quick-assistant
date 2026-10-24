import { and, asc, eq, ne } from "drizzle-orm";
import { Suspense } from "react";
import { db as platformDb } from "@/db";
import { categories, member, menuItemCategories, menuItemModifierGroups, menuItems, modifierGroups, organization } from "@/db/schema";
import { isOwner } from "@/lib/role-utils";
import { requireTenant } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant-db";
import { MenuEditor } from "./menu-editor";

async function MenuContent() {
  const { tenantId, role, user } = await requireTenant();
  // Other restaurants this user OWNS: the menu can be copied from them (shown only when there is one).
  const copySources = isOwner(role)
    ? await platformDb
        .select({ id: organization.id, name: organization.name })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(and(eq(member.userId, user.id), eq(member.role, "owner"), ne(member.organizationId, tenantId)))
        .orderBy(asc(organization.name))
    : [];
  // As THIS restaurant inside the database (row-level security), on top of the explicit filters.
  const { items, groups, links, cats, catLinks } = await withTenant(tenantId, async (db) => {
    const items = await db
      .select({
        id: menuItems.id,
        name: menuItems.name,
        description: menuItems.description,
        priceCents: menuItems.priceCents,
        available: menuItems.available,
      })
      .from(menuItems)
      .where(eq(menuItems.tenantId, tenantId))
      .orderBy(asc(menuItems.name));
    const groups = await db
      .select({ id: modifierGroups.id, name: modifierGroups.name })
      .from(modifierGroups)
      .where(eq(modifierGroups.tenantId, tenantId))
      .orderBy(asc(modifierGroups.sortOrder), asc(modifierGroups.name));
    const links = await db
      .select({ menuItemId: menuItemModifierGroups.menuItemId, groupId: menuItemModifierGroups.groupId })
      .from(menuItemModifierGroups)
      .innerJoin(menuItems, eq(menuItems.id, menuItemModifierGroups.menuItemId))
      .where(eq(menuItems.tenantId, tenantId));
    const cats = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.tenantId, tenantId))
      .orderBy(asc(categories.sortOrder), asc(categories.name));
    const catLinks = await db
      .select({ menuItemId: menuItemCategories.menuItemId, categoryId: menuItemCategories.categoryId })
      .from(menuItemCategories)
      .innerJoin(menuItems, eq(menuItems.id, menuItemCategories.menuItemId))
      .where(eq(menuItems.tenantId, tenantId));
    return { items, groups, links, cats, catLinks };
  });
  return (
    <MenuEditor
      canEdit={isOwner(role)}
      copySources={copySources}
      groups={groups}
      categories={cats}
      items={items.map((i) => ({
        ...i,
        groupIds: links.filter((l) => l.menuItemId === i.id).map((l) => l.groupId),
        categoryIds: catLinks.filter((l) => l.menuItemId === i.id).map((l) => l.categoryId),
      }))}
    />
  );
}

export default function MenuPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading menu…</p>}>
      <MenuContent />
    </Suspense>
  );
}
