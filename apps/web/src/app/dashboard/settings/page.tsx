import { asc, eq } from "drizzle-orm";
import { Suspense } from "react";
import { phoneNumbers, tenantSettings } from "@/db/schema";
import { isOwner } from "@/lib/role-utils";
import { requireTenant } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant-db";
import { Details } from "./details";
import { Hours } from "./hours";
import { PhoneNumbers } from "./phone-numbers";

// Settings -> General. Notifications, Team and Kitchen printing are their own tabs (./notifications, ./team, ./printing).
async function GeneralContent() {
  const { tenantId, role } = await requireTenant();
  if (!isOwner(role)) {
    return <p className="text-muted-foreground">Only the restaurant owner can change settings.</p>;
  }
  // As THIS restaurant inside the database (row-level security), on top of the explicit filters.
  const [numbers, [settings]] = await withTenant(tenantId, async (db) => {
    return Promise.all([
      db
        .select({ e164: phoneNumbers.e164 })
        .from(phoneNumbers)
        .where(eq(phoneNumbers.tenantId, tenantId))
        .orderBy(asc(phoneNumbers.createdAt)),
      db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)),
    ]);
  });

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Agent phone number</h2>
        <PhoneNumbers numbers={numbers.map((r) => r.e164)} />
      </section>
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Restaurant details</h2>
        <Details address={settings?.address ?? ""} humanLine={settings?.transferNumber ?? ""} />
      </section>
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Opening hours</h2>
        <Hours timezone={settings?.timezone ?? "America/New_York"} hours={settings?.openingHours ?? null} />
      </section>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <GeneralContent />
    </Suspense>
  );
}
