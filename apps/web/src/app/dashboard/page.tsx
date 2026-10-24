import { Suspense } from "react";
import { requireTenant } from "@/lib/tenant";

async function DashboardContent() {
  await requireTenant(); // signed in and a member of a restaurant (else redirected)

  return (
    <p className="text-muted-foreground">
      Manage your menu under the Menu tab and follow incoming orders under Orders.
    </p>
  );
}

export default function Dashboard() {
  return (
    <main>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <DashboardContent />
      </Suspense>
    </main>
  );
}
