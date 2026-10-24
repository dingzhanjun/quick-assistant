import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orders, organization, printAgents, printers, printJobs, tenantSettings } from "@/db/schema";
import { type TenantTx, withTenant } from "../tenant-db";
import { dotsForMm, renderTicketPng } from "./render";
import { buildTicket, testTicket, type Ticket, type TicketKind } from "./ticket";

// Creates the kitchen tickets for one order: one print job per enabled printer of the restaurant. Never throws (a
// printing problem must not affect the order); the dedupe key makes a retry or double trigger a no-op, except for
// reprints, which are deliberate.
export async function enqueuePrint(
  tenantId: string,
  orderId: string,
  kind: Exclude<TicketKind, "test">,
  opts: { replaces?: number } = {},
): Promise<number> {
  try {
    return await withTenant(tenantId, (tx) => createJobs(tx, tenantId, orderId, kind, opts.replaces));
  } catch (e) {
    console.error(`print: could not create ${kind} ticket for order ${orderId}:`, e);
    return 0;
  }
}

export async function createJobs(tx: TenantTx, tenantId: string, orderId: string, kind: Exclude<TicketKind, "test">, replaces?: number) {
  // Enabled printers whose print agent has not been revoked: a revoked agent (an old Pi that was replaced) never collects tickets,
  // so a job for its printer would just sit there and keep the order on "Printing…". An offline agent still gets its tickets (they wait).
  const active = (
    await tx
      .select({ printer: printers })
      .from(printers)
      .leftJoin(printAgents, eq(printAgents.id, printers.agentId))
      .where(and(eq(printers.tenantId, tenantId), eq(printers.enabled, true), isNull(printAgents.revokedAt)))
  ).map((r) => r.printer);
  if (!active.length) return 0;

  const [settings] = await tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  const [tenant] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, tenantId));
  const order = await tx.query.orders.findFirst({ where: and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)), with: { items: true } });
  if (!tenant || !order) return 0;

  // A "cancelled" ticket only makes sense if the kitchen was given the order in the first place.
  if (kind === "cancelled") {
    const earlier = await tx.select({ id: printJobs.id }).from(printJobs).where(and(eq(printJobs.orderId, orderId), inArray(printJobs.kind, ["new", "changed", "reprint"]))).limit(1);
    if (!earlier.length) return 0;
  }

  const ticket = buildTicket({
    kind, restaurant: tenant.name, timezone: settings?.timezone ?? "America/New_York", replaces,
    order,
  });
  return insertJobs(tx, tenantId, active, ticket, orderId, kind);
}

// Test ticket for one printer (Settings -> Printing).
export async function enqueueTestPrint(tenantId: string, printerId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const [p] = await tx.select().from(printers).where(and(eq(printers.id, printerId), eq(printers.tenantId, tenantId)));
    if (!p) return false;
    const [tenant] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, tenantId));
    const [settings] = await tx.select({ timezone: tenantSettings.timezone }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    await insertJobs(tx, tenantId, [p], testTicket(tenant?.name ?? "Restaurant", settings?.timezone ?? "America/New_York"), null, "test");
    return true;
  });
}

async function insertJobs(tx: TenantTx, tenantId: string, targets: { id: string; paperWidthMm: number }[], ticket: Ticket, orderId: string | null, kind: TicketKind) {
  const images = new Map<number, Buffer>(); // rendered once per paper width
  let created = 0;
  for (const p of targets) {
    const dots = dotsForMm(p.paperWidthMm);
    if (!images.has(dots)) images.set(dots, renderTicketPng(ticket, dots));
    // reprint / test are deliberate repeats; everything else is one ticket per order + kind + printer
    const dedupeKey = kind === "reprint" || kind === "test" ? `${kind}:${randomUUID()}` : `${orderId}:${kind}:${p.id}`;
    const rows = await tx
      .insert(printJobs)
      .values({ tenantId, printerId: p.id, orderId, kind, ticket, image: images.get(dots)!, dedupeKey })
      .onConflictDoNothing({ target: printJobs.dedupeKey })
      .returning({ id: printJobs.id });
    created += rows.length;
  }
  return created;
}
