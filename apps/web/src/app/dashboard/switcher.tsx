import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { member, organization } from "@/db/schema";
import { RestaurantSwitcher } from "@/components/restaurant-switcher";
import { requireTenant } from "@/lib/tenant";

// Server wrapper: resolves the effective restaurant and the user's memberships.
export async function Switcher() {
  const { tenantId, user } = await requireTenant();
  const restaurants = await db
    .select({ id: organization.id, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, user.id))
    .orderBy(asc(member.createdAt));
  return <RestaurantSwitcher current={tenantId} restaurants={restaurants} />;
}
