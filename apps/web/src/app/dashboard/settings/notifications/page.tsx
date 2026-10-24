import { and, eq } from "drizzle-orm";
import { Suspense } from "react";
import { member, tenantSettings, user } from "@/db/schema";
import { isOwner } from "@/lib/role-utils";
import { smsConfigured } from "@/lib/sms";
import { requireTenant } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant-db";
import { Notifications } from "../notifications";

async function NotificationsContent() {
  const { tenantId, role } = await requireTenant();
  if (!isOwner(role)) {
    return <p className="text-muted-foreground">Only the restaurant owner can change settings.</p>;
  }
  // As THIS restaurant inside the database (row-level security), on top of the explicit filters.
  const [[settings], owners] = await withTenant(tenantId, (db) =>
    Promise.all([
      db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)),
      db
        .select({ email: user.email })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, tenantId), eq(member.role, "owner"))),
    ]),
  );
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Notifications</h2>
      <Notifications
        emails={settings?.notifyEmails ?? ""}
        enabled={settings?.notifyNewOrders ?? true}
        ownerEmails={owners.map((o) => o.email).join(", ")}
        textOrders={settings?.textOrderLink ?? true}
        textAvailable={smsConfigured()}
      />
    </section>
  );
}

export default function NotificationsPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <NotificationsContent />
    </Suspense>
  );
}
