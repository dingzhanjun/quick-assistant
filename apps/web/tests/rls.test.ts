// Row-level security (migration 0016): inside withTenant() the DATABASE enforces the restaurant boundary.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";

// drizzle wraps the Postgres error ("Failed query"); the real message is in `cause`
const rejectsWith = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e: Error & { cause?: Error }) => re.test(`${e.cause?.message ?? ""} ${e.message}`));

const run = randomUUID().slice(0, 8);
const A = `rls-a-${run}`, B = `rls-b-${run}`;
let db: typeof import("../src/db")["db"];
let S: typeof import("../src/db/schema");
let withTenant: typeof import("../src/lib/tenant-db")["withTenant"];
let bItem: { id: string }, bOrder: { id: string };

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  ({ withTenant } = await import("../src/lib/tenant-db"));
  for (const id of [A, B]) await db.insert(S.organization).values({ id, name: id, slug: id, createdAt: new Date() });
  await db.insert(S.menuItems).values({ tenantId: A, name: "A dish", priceCents: 100 });
  [bItem] = await db.insert(S.menuItems).values({ tenantId: B, name: "B dish", priceCents: 200 }).returning();
  [bOrder] = await db.insert(S.orders).values({ tenantId: B, orderNumber: 1 }).returning();
  await db.insert(S.orderItems).values({ orderId: bOrder.id, menuItemId: bItem.id, name: "B dish", priceCents: 200, quantity: 1 });
  await db.insert(S.tenantSettings).values([{ tenantId: A }, { tenantId: B }]);
});
after(async () => {
  for (const id of [A, B]) await db.delete(S.organization).where(eq(S.organization.id, id));
  process.exit(0);
});

test("a query WITHOUT any tenant filter only sees the current restaurant", async () => {
  const items = await withTenant(A, (tx) => tx.select().from(S.menuItems)); // no where clause on purpose
  assert.ok(items.length >= 1 && items.every((i) => i.tenantId === A), "saw another restaurant's menu");
  const orders = await withTenant(A, (tx) => tx.select().from(S.orders));
  assert.ok(orders.every((o) => o.tenantId === A) && !orders.some((o) => o.id === bOrder.id));
  const lines = await withTenant(A, (tx) => tx.select().from(S.orderItems)); // child table: ownership via its order
  assert.equal(lines.filter((l) => l.orderId === bOrder.id).length, 0);
  const asB = await withTenant(B, (tx) => tx.select().from(S.orderItems));
  assert.equal(asB.filter((l) => l.orderId === bOrder.id).length, 1);
});

test("with no restaurant set, nothing is visible (fail closed)", async () => {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', 'order_app', true)`);
    return tx.select().from(S.menuItems);
  });
  assert.equal(rows.length, 0);
});

test("another restaurant's rows cannot be changed, deleted or inserted", async () => {
  const upd = await withTenant(A, (tx) => tx.update(S.menuItems).set({ name: "HACKED" }).where(eq(S.menuItems.id, bItem.id)).returning());
  const del = await withTenant(A, (tx) => tx.delete(S.menuItems).where(eq(S.menuItems.id, bItem.id)).returning());
  assert.deepEqual([upd.length, del.length], [0, 0]);
  const [still] = await db.select().from(S.menuItems).where(eq(S.menuItems.id, bItem.id));
  assert.equal(still.name, "B dish");

  await rejectsWith(withTenant(A, (tx) => tx.insert(S.menuItems).values({ tenantId: B, name: "planted", priceCents: 1 })), /row-level security/i);
  await rejectsWith(withTenant(A, (tx) => tx.insert(S.orderItems).values({ orderId: bOrder.id, name: "planted", priceCents: 1, quantity: 1 })), /row-level security/i);
  await withTenant(A, (tx) => tx.insert(S.menuItems).values({ tenantId: A, name: "mine", priceCents: 1 })); // own rows: fine
});

test("a restaurant cannot lift its own suspension, touch phone numbers, or read the audit log", async () => {
  await rejectsWith(withTenant(A, (tx) => tx.update(S.tenantSettings).set({ suspended: false }).where(eq(S.tenantSettings.tenantId, A))), /permission denied/i);
  await withTenant(A, (tx) => tx.update(S.tenantSettings).set({ address: "1 Main St" }).where(eq(S.tenantSettings.tenantId, A))); // allowed columns
  await rejectsWith(withTenant(A, (tx) => tx.insert(S.phoneNumbers).values({ e164: `+1555${Math.floor(Math.random() * 1e7)}`, tenantId: A })), /permission denied/i);
  await rejectsWith(withTenant(A, (tx) => tx.select().from(S.auditLogs)), /permission denied/i);
  await rejectsWith(withTenant(A, (tx) => tx.select().from(S.jobs)), /permission denied/i);
});

test("every table that holds restaurant data is row-secured (guards future tables)", async () => {
  // tables with a tenant_id column, plus child tables that inherit ownership, must have RLS on, unless exempt on purpose
  const EXEMPT = new Set(["audit_logs"]); // written/read only by platform code
  const rows = await db.execute<{ table_name: string; rls: boolean }>(sql`
    select c.table_name, cl.relrowsecurity as rls
    from information_schema.columns c
    join pg_class cl on cl.relname = c.table_name and cl.relnamespace = 'public'::regnamespace
    where c.table_schema = 'public' and c.column_name = 'tenant_id'`);
  const unprotected = [...rows].filter((r) => !r.rls && !EXEMPT.has(r.table_name)).map((r) => r.table_name);
  assert.deepEqual(unprotected, [], `these tables have a tenant_id but no row-level security: ${unprotected.join(", ")}`);
  const kids = await db.execute<{ relname: string; rls: boolean }>(sql`select relname, relrowsecurity as rls from pg_class where relname in ('order_items','menu_item_modifier_groups','menu_item_categories')`);
  assert.equal([...kids].length, 3);
  assert.ok([...kids].every((k) => k.rls));
});
