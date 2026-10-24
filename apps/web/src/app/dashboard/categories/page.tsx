import { asc, eq, sql } from "drizzle-orm";
import { Suspense } from "react";
import { categories, menuItemCategories } from "@/db/schema";
import { isOwner } from "@/lib/role-utils";
import { requireTenant } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant-db";
import { CategoryEditor } from "./category-editor";

async function CategoriesContent() {
  const { tenantId, role } = await requireTenant();
  if (!isOwner(role)) return <p className="text-muted-foreground">Only the restaurant owner can manage categories.</p>;
  const rows = await withTenant(tenantId, (db) =>
    db
      .select({
        id: categories.id,
        name: categories.name,
        itemCount: sql<number>`(select count(*)::int from ${menuItemCategories} where ${menuItemCategories.categoryId} = ${categories.id})`,
      })
      .from(categories)
      .where(eq(categories.tenantId, tenantId))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
  );
  return <CategoryEditor categories={rows} />;
}

export default function CategoriesPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <CategoriesContent />
    </Suspense>
  );
}
