// Kitchen printing, phase 1: ticket picture, job creation, restaurant isolation (PRINTING_PLAN.md).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";

const rejectsWith = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e: Error & { cause?: Error }) => re.test(`${e.cause?.message ?? ""} ${e.message}`));

const run = randomUUID().slice(0, 8);
const A = `print-a-${run}`, B = `print-b-${run}`;
let db: typeof import("../src/db")["db"];
let S: typeof import("../src/db/schema");
let withTenant: typeof import("../src/lib/tenant-db")["withTenant"];
let P: typeof import("../src/lib/print/jobs");
let renderTicketPng: typeof import("../src/lib/print/render")["renderTicketPng"];
let printerA: { id: string }, printerB: { id: string };
let dishId: string;

async function newOrder(tenantId: string, n: number) {
  const [o] = await db.insert(S.orders).values({ tenantId, orderNumber: n, customerName: "Wei" }).returning();
  await db.insert(S.orderItems).values({
    orderId: o.id, menuItemId: tenantId === A ? dishId : null, name: "Fried Rice", priceCents: 1000, quantity: 2,
    notes: "no egg", modifiers: [{ group: "Size", option: "Large", priceDeltaCents: 200 }],
  });
  return o;
}
const jobsFor = (tenantId: string, orderId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(S.printJobs).where(eq(S.printJobs.orderId, orderId)));

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  ({ withTenant } = await import("../src/lib/tenant-db"));
  P = await import("../src/lib/print/jobs");
  ({ renderTicketPng } = await import("../src/lib/print/render"));
  for (const id of [A, B]) await db.insert(S.organization).values({ id, name: `Rest ${id}`, slug: id, createdAt: new Date() });
  await db.insert(S.tenantSettings).values([{ tenantId: A }, { tenantId: B }]);
  [printerA] = await db.insert(S.printers).values({ tenantId: A, name: "Kitchen" }).returning();
  [printerB] = await db.insert(S.printers).values({ tenantId: B, name: "Kitchen", paperWidthMm: 58 }).returning();
  [{ id: dishId }] = await db.insert(S.menuItems).values({ tenantId: A, name: "Fried Rice", priceCents: 1000 }).returning();
});
after(async () => {
  for (const id of [A, B]) await db.delete(S.organization).where(eq(S.organization.id, id));
  process.exit(0);
});

test("the ticket picture is a valid 1-bit PNG of the paper width", () => {
  const ticket = { kind: "new", restaurant: "Test Kitchen", orderNumber: 5, pickup: "ASAP", placedAt: "6:00 PM", lines: [{ quantity: 1, name: "X", options: [], notes: "n" }], totalCents: 100 } as const;
  for (const [w, mm] of [[576, 80], [384, 58]] as const) {
    const png = renderTicketPng(ticket as never, w);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${mm} mm: PNG signature`);
    assert.equal(png.readUInt32BE(16), w);
    assert.equal(png[24], 1, "bit depth 1");
    const height = png.readUInt32BE(20);
    const idat = png.subarray(png.indexOf("IDAT") + 4, png.indexOf("IEND") - 8);
    assert.equal(inflateSync(idat).length, (Math.ceil(w / 8) + 1) * height);
    assert.ok(png.length < 40_000, "small enough to download in a blink");
  }
});

test("a new order creates one job per enabled printer and no duplicates", async () => {
  const o = await newOrder(A, 1);
  assert.equal(await P.enqueuePrint(A, o.id, "new"), 1);
  assert.equal(await P.enqueuePrint(A, o.id, "new"), 0, "double trigger is a no-op");
  const [job] = await jobsFor(A, o.id);
  assert.equal(job.status, "pending");
  assert.deepEqual(job.ticket.lines[0].options, ["Large"]);
  assert.equal(job.ticket.totalCents, 2400);
  assert.equal(job.ticket.lines[0].lineCents, 2400, "each line carries its price");
  assert.match(job.ticket.placedAt, /^\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M$/, "MM/dd/yyyy + time");
  assert.equal(job.ticket.pickup, "ASAP");
  assert.equal(job.image.readUInt32BE(16), 576);
});

test("disabled printers get nothing", async () => {
  await db.update(S.printers).set({ enabled: false }).where(eq(S.printers.id, printerA.id));
  const o2 = await newOrder(A, 3);
  assert.equal(await P.enqueuePrint(A, o2.id, "new"), 0);
  await db.update(S.printers).set({ enabled: true }).where(eq(S.printers.id, printerA.id));
});

test("a CANCELLED ticket is only sent for an order that was printed; a reprint is always new", async () => {
  const fresh = await newOrder(A, 4);
  assert.equal(await P.enqueuePrint(A, fresh.id, "cancelled"), 0, "kitchen never saw it");
  await P.enqueuePrint(A, fresh.id, "new");
  assert.equal(await P.enqueuePrint(A, fresh.id, "cancelled"), 1);
  assert.equal(await P.enqueuePrint(A, fresh.id, "reprint"), 1);
  assert.equal(await P.enqueuePrint(A, fresh.id, "reprint"), 1, "reprints are deliberate");
  const kinds = (await jobsFor(A, fresh.id)).map((j) => j.kind).sort();
  assert.deepEqual(kinds, ["cancelled", "new", "reprint", "reprint"]);
});

test("a changed order's ticket says which order it replaces; test tickets need no order", async () => {
  const o = await newOrder(A, 5);
  await P.enqueuePrint(A, o.id, "changed", { replaces: 4 });
  assert.equal((await jobsFor(A, o.id))[0].ticket.replaces, 4);
  assert.equal(await P.enqueueTestPrint(A, printerA.id), true);
  assert.equal(await P.enqueueTestPrint(A, printerB.id), false, "another restaurant's printer");
});

test("a restaurant never sees or creates another restaurant's printing data", async () => {
  const oB = await newOrder(B, 1);
  await P.enqueuePrint(B, oB.id, "new");
  assert.equal((await jobsFor(B, oB.id))[0].image.readUInt32BE(16), 384, "58 mm printer");
  const asA = await withTenant(A, (tx) => tx.select().from(S.printJobs));
  assert.ok(asA.length > 0 && asA.every((j) => j.tenantId === A));
  assert.equal((await withTenant(A, (tx) => tx.select().from(S.printers))).every((p) => p.tenantId === A), true);
  await rejectsWith(withTenant(A, (tx) => tx.insert(S.printers).values({ tenantId: B, name: "planted" })), /row-level security/i);
  await rejectsWith(withTenant(A, (tx) => tx.insert(S.printJobs).values({ tenantId: B, printerId: printerB.id, kind: "test", ticket: asA[0].ticket, image: Buffer.from([1]), dedupeKey: randomUUID() })), /row-level security/i);
  assert.equal((await withTenant(A, (tx) => tx.delete(S.printers).where(eq(S.printers.id, printerB.id)).returning())).length, 0);
});

test("restaurant code can write but never read an agent's token hash", async () => {
  await withTenant(A, (tx) => tx.insert(S.printAgents).values({ tenantId: A, name: "Pi", tokenHash: "h", pairingCodeHash: "p" }));
  const rows = await withTenant(A, (tx) => tx.select({ id: S.printAgents.id, name: S.printAgents.name }).from(S.printAgents));
  assert.equal(rows.length, 1);
  await rejectsWith(withTenant(A, (tx) => tx.select({ h: S.printAgents.tokenHash }).from(S.printAgents)), /permission denied/i);
});

test("a job insert wakes the print agents (NOTIFY print_jobs)", async () => {
  const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_trigger where tgname = 'print_jobs_notify'`);
  assert.equal([...rows][0].n, 1);
});
