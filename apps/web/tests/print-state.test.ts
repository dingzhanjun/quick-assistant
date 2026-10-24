// The "Printing…" label must not stick: tickets stuck on a printer nobody can reach (an old Pi) are ignored, and a revoked
// agent neither receives new tickets nor leaves old ones waiting. Needs a migrated Postgres (DATABASE_URL).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { printStateOf, type JobForState } from "../src/lib/print/state";

const T = `ps-${randomUUID().slice(0, 8)}`;
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/tenant.ts"), { namedExports: { requireTenant: async () => ({ tenantId: T, role: "owner", user: { id: "u", email: "u@x" } }) } });
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

const at = (n: number) => new Date(1_700_000_000_000 + n * 1000);
const job = (status: string, n: number, o: { deliverable?: boolean; online?: boolean } = {}): JobForState => ({
  status, createdAt: at(n), deliverable: o.deliverable ?? true, online: o.online ?? true,
});
const offline = { online: false };
const revoked = { deliverable: false, online: false };

test("printStateOf: printing, waiting, printed, failed; tickets stuck on old printers never hide a real print", () => {
  assert.equal(printStateOf([]), "none");
  assert.equal(printStateOf([job("pending", 1)]), "printing");
  assert.equal(printStateOf([job("leased", 1)]), "printing");
  assert.equal(printStateOf([job("done", 1)]), "printed");
  assert.equal(printStateOf([job("done", 1), job("failed", 2)]), "failed", "the newest settled ticket decides");
  assert.equal(printStateOf([job("failed", 1), job("done", 2)]), "printed");
  // the reported bug: the real printer printed (twice), but a ticket for an old Pi that was replaced and is offline sits there forever
  assert.equal(printStateOf([job("done", 1), job("done", 3), job("pending", 3, offline)]), "printed");
  assert.equal(printStateOf([job("done", 3), job("pending", 3, revoked)]), "printed");
  // a ticket still on its way to a printer that is reachable does show "Printing…"
  assert.equal(printStateOf([job("done", 1), job("pending", 3)]), "printing");
  assert.equal(printStateOf([job("pending", 3), job("pending", 3, offline)]), "printing");
  // nothing printed and the only printer is offline: say so, instead of "Printing…"
  assert.equal(printStateOf([job("pending", 3, offline)]), "waiting");
  // a revoked or switched-off printer's ticket is nobody's business
  assert.equal(printStateOf([job("pending", 3, revoked)]), "none");
});

type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");
let P: typeof import("../src/lib/print/jobs");
before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  P = await import("../src/lib/print/jobs");
  await db.insert(S.organization).values({ id: T, name: "Print state", slug: T, createdAt: new Date() });
});
after(async () => {
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  await db.delete(S.organization).where(eq(S.organization.id, T));
  process.exit(0);
});

test("a revoked agent's printer gets no new tickets; revoking fails the tickets still waiting for it", async () => {
  const [oldAgent] = await db.insert(S.printAgents).values({ tenantId: T, name: "Old Pi", tokenHash: `h1-${T}` }).returning();
  const [newAgent] = await db.insert(S.printAgents).values({ tenantId: T, name: "New Pi", tokenHash: `h2-${T}` }).returning();
  const [oldPrinter] = await db.insert(S.printers).values({ tenantId: T, agentId: oldAgent.id, name: "Old", deviceKey: "lp0" }).returning();
  const [newPrinter] = await db.insert(S.printers).values({ tenantId: T, agentId: newAgent.id, name: "New", deviceKey: "lp0" }).returning();
  const [order] = await db.insert(S.orders).values({ tenantId: T, orderNumber: 1, customerName: "Pat" }).returning();

  // both agents are active: a reprint reaches both printers
  assert.equal(await P.enqueuePrint(T, order.id, "reprint"), 2);
  const before = await db.select().from(S.printJobs).where(eq(S.printJobs.orderId, order.id));
  assert.deepEqual(before.map((j) => j.printerId).sort(), [oldPrinter.id, newPrinter.id].sort());

  // the old Pi is revoked (it was replaced): its waiting ticket is given up at once
  const actions = await import("../src/app/dashboard/settings/print-actions");
  assert.deepEqual(await actions.revokePrintAgent(oldAgent.id), { ok: true });
  const afterRevoke = await db.select().from(S.printJobs).where(eq(S.printJobs.orderId, order.id));
  const oldJob = afterRevoke.find((j) => j.printerId === oldPrinter.id)!;
  assert.equal(oldJob.status, "failed");
  assert.match(oldJob.error ?? "", /revoked/);
  assert.equal(afterRevoke.find((j) => j.printerId === newPrinter.id)!.status, "pending", "the live printer's ticket is untouched");

  // and from now on only the live printer gets tickets
  assert.equal(await P.enqueuePrint(T, order.id, "reprint"), 1);
  const jobs = await db.select().from(S.printJobs).where(eq(S.printJobs.orderId, order.id));
  assert.equal(jobs.filter((j) => j.printerId === oldPrinter.id).length, 1, "no new ticket for the revoked agent's printer");
  assert.equal(jobs.filter((j) => j.printerId === newPrinter.id).length, 2);
});
