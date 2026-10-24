import { sql } from "drizzle-orm";
import { db } from "@/db";

export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Runs `fn` as ONE restaurant, enforced by the database (migration 0016, row-level security): inside a transaction the
// connection switches to the low-privilege role `order_app` and sets app.tenant_id, so every query below sees and can
// write only that restaurant's rows, whatever the query says. A missing `where tenant_id = ...` therefore returns
// nothing instead of leaking another restaurant's data. Use it for everything that acts on behalf of a restaurant (its
// dashboard, the phone agent after the dialed number is resolved). Platform-level code (admin pages, background jobs,
// the audit log) keeps using `db` directly. Pass the `tx` to helpers instead of `db`.
export async function withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config('role', ...) is SET LOCAL ROLE; both settings end with the transaction
    await tx.execute(sql`select set_config('role', 'order_app', true), set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
