// Human transfer line: set only by the platform admin, handed to the agent with the menu, never clobbered
// by restaurant settings saves, and every forward is audited.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

process.env.AGENT_API_KEY = "test-agent-key";
const run = randomUUID().slice(0, 8);
const T = `xfer-${run}`;
let currentRole = "owner";
const NUM = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
const file = (p: string) => pathToFileURL(path.resolve(p)).href;
mock.module(file("src/lib/admin.ts"), { namedExports: { requirePlatformAdmin: async () => ({ id: "adm", email: "admin@example.com" }) } });
mock.module(file("src/lib/tenant.ts"), { namedExports: { requireTenant: async () => ({ tenantId: T, role: currentRole, user: { id: "u", email: "o@example.com" } }) } });
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
mock.module("next/server", { namedExports: { NextResponse, after: () => {} } });

let db: typeof import("../src/db")["db"];
let S: typeof import("../src/db/schema");
before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  await db.insert(S.organization).values({ id: T, name: T, slug: T, createdAt: new Date() });
  await db.insert(S.phoneNumbers).values({ e164: NUM, tenantId: T });
});
after(async () => {
  await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  await db.delete(S.organization).where(eq(S.organization.id, T));
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, NUM));
  process.exit(0);
});

const agentGet = async (route: string, qs: string) => {
  const mod = await import(`../src/app/api/agent/${route}/route`);
  return (await mod.GET(new Request(`http://t/api/agent/${route}?${qs}`, { headers: { authorization: "Bearer test-agent-key" } }))) as Response;
};

test("admin sets, validates and clears the human line; the agent receives it with the menu", async () => {
  const admin = await import("../src/app/admin/actions");
  assert.equal((await admin.setTransferNumber(T, "not a number")).ok, false);
  assert.equal((await admin.setTransferNumber(T, "+1 (415) 555-0199")).ok, true);

  const menu = (await (await agentGet("menu", `to=${encodeURIComponent(NUM)}`)).json()) as { transfer_number: string | null };
  assert.equal(menu.transfer_number, "+14155550199");

  // a restaurant saving its own settings must not wipe the admin's number
  const settings = await import("../src/app/dashboard/settings/actions");
  await settings.saveHours("America/New_York", null);
  await settings.saveNotifications("x@example.com", true);
  const [row] = await db.select().from(S.tenantSettings).where(eq(S.tenantSettings.tenantId, T));
  assert.equal(row.transferNumber, "+14155550199");

  const [log] = await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, T), eq(S.auditLogs.action, "admin.transfer_number_changed")));
  assert.equal(log.actorLabel, "admin@example.com");

  assert.equal((await admin.setTransferNumber(T, "")).ok, true);
  const cleared = (await (await agentGet("menu", `to=${encodeURIComponent(NUM)}`)).json()) as { transfer_number: string | null };
  assert.equal(cleared.transfer_number, null);
});

test("the restaurant owner sets its own human line; staff cannot; the agent's own numbers are refused", async () => {
  const settings = await import("../src/app/dashboard/settings/actions");
  assert.equal((await settings.saveHumanLine("+1 (415) 555-0123")).ok, true);
  const menu = (await (await agentGet("menu", `to=${encodeURIComponent(NUM)}`)).json()) as { transfer_number: string | null };
  assert.equal(menu.transfer_number, "+14155550123");

  // forwarding a call to the agent's own number would just ring the agent again
  const own = await settings.saveHumanLine(NUM);
  assert.equal(own.ok, false);
  assert.match((own as { error: string }).error, /agent phone number/);
  assert.equal((await settings.saveHumanLine("abc")).ok, false);

  const [log] = await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, T), eq(S.auditLogs.action, "settings.human_line_updated")));
  assert.equal(log.actorLabel, "o@example.com");

  assert.equal((await settings.saveHumanLine("")).ok, true);
  assert.equal((await (await agentGet("menu", `to=${encodeURIComponent(NUM)}`)).json() as { transfer_number: null }).transfer_number, null);
});

test("forwarded and failed transfers are written to the audit log", async () => {
  const mod = await import("../src/app/api/agent/calls/transfer/route");
  const post = (body: unknown) =>
    mod.POST(new Request("http://t", { method: "POST", headers: { authorization: "Bearer test-agent-key", "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await post({ to: NUM, call_id: "c1", via: "keypad", ok: true })).status, 200);
  assert.equal((await post({ to: NUM, call_id: "c2", via: "request", ok: false, error: "busy" })).status, 200);
  const logs = await db.select().from(S.auditLogs).where(eq(S.auditLogs.tenantId, T));
  const by = Object.fromEntries(logs.map((l) => [l.action, l.summary]));
  assert.match(by["call.transferred"], /pressed 0/);
  assert.match(by["call.transfer_failed"], /busy/);
  assert.equal((await mod.POST(new Request("http://t", { method: "POST", body: "{}" }))).status, 401);
});

test("a staff member cannot change the human line", async () => {
  currentRole = "member";
  try {
    const settings = await import("../src/app/dashboard/settings/actions");
    assert.equal((await settings.saveHumanLine("+14155550177")).ok, false);
  } finally {
    currentRole = "owner";
  }
  const [row] = await db.select().from(S.tenantSettings).where(eq(S.tenantSettings.tenantId, T));
  assert.notEqual(row.transferNumber, "+14155550177");
});

test("a restaurant has exactly one agent number: a second is refused until the first is removed", async () => {
  const admin = await import("../src/app/admin/actions");
  const other = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
  const refused = await admin.addTenantNumber(T, other);
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /already has an agent number/);
  assert.equal((await db.select().from(S.phoneNumbers).where(eq(S.phoneNumbers.tenantId, T))).length, 1);

  // even a direct insert cannot create a second one (database rule)
  await assert.rejects(db.insert(S.phoneNumbers).values({ e164: other, tenantId: T }));

  assert.equal((await admin.removeTenantNumber(T, NUM)).ok, true);
  assert.equal((await admin.addTenantNumber(T, other)).ok, true);
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, other));
  await db.insert(S.phoneNumbers).values({ e164: NUM, tenantId: T }); // restore for the cleanup in after()
});
