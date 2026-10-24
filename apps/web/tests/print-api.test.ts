// Print agent protocol (PRINTING_PLAN.md phase 2): pairing, long-poll, lease/retry, image, result, heartbeat, service
// commands, revocation, restaurant isolation. A fake agent calls the route handlers directly.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";

let current = "";
const currentRole = "owner";
mock.module(pathToFileURL(path.resolve("src/lib/tenant.ts")).href, {
  namedExports: { requireTenant: async () => ({ tenantId: current, role: currentRole, user: { id: "u", email: "owner@x" } }) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

const run = randomUUID().slice(0, 8);
const A = `pa-a-${run}`, B = `pa-b-${run}`;
let db: typeof import("../src/db")["db"];
let S: typeof import("../src/db/schema");
let P: typeof import("../src/lib/print/jobs");
let AG: typeof import("../src/lib/print/agent");
let Q: typeof import("../src/lib/print/service");
let actions: typeof import("../src/app/dashboard/settings/print-actions");
let tokenA = "", tokenB = "", agentA = "", printerA = "";
let n = 0;

const call = async (route: string, method: string, token: string | null, body?: unknown, params?: Record<string, string>) => {
  const mod = await import(`../src/app/api/print/${route}/route`);
  const req = new Request(`http://t/api/print/${route}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "x-forwarded-for": `10.0.0.${run}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (mod[method] as (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req, { params: Promise.resolve(params ?? {}) });
};
type Polled = { status: number; body: { type: string; job: { id: string; device: string; copies: number; kind: string }; command: { id: string; command: string } } | null };
const poll = (token: string) => pollWith(token, 0);
const pollWith = async (token: string, wait: number): Promise<Polled> => {
  const mod = await import("../src/app/api/print/poll/route");
  const r = await mod.GET(new Request(`http://t/api/print/poll?wait=${wait}`, { headers: { authorization: `Bearer ${token}` } }));
  return { status: r.status, body: r.status === 200 ? ((await r.json()) as Polled["body"]) : null } as Polled;
};

async function pairedAgent(tenantId: string, name: string, code: string, devices: { key: string }[] = [{ key: "lp0" }]) {
  const [a] = await db.insert(S.printAgents).values({ tenantId, name, pairingCodeHash: AG.hashCode(code), pairingExpiresAt: new Date(Date.now() + 600_000) }).returning();
  const r = await call("pair", "POST", null, { code, version: "0.1.0", hostname: "pi", lan_ip: "192.168.1.47", devices });
  assert.equal(r.status, 200);
  return { id: a.id, token: ((await r.json()) as { token: string }).token };
}
async function newJob(tenantId: string) {
  const [o] = await db.insert(S.orders).values({ tenantId, orderNumber: ++n }).returning();
  await db.insert(S.orderItems).values({ orderId: o.id, name: "Rice", priceCents: 500, quantity: 1 });
  assert.equal(await P.enqueuePrint(tenantId, o.id, "new"), 1);
  const [j] = await db.select().from(S.printJobs).where(eq(S.printJobs.orderId, o.id));
  return j;
}

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  P = await import("../src/lib/print/jobs");
  AG = await import("../src/lib/print/agent");
  Q = await import("../src/lib/print/service");
  actions = await import("../src/app/dashboard/settings/print-actions");
  for (const id of [A, B]) await db.insert(S.organization).values({ id, name: `R ${id}`, slug: id, createdAt: new Date() });
  await db.insert(S.tenantSettings).values([{ tenantId: A }, { tenantId: B }]);
  ({ id: agentA, token: tokenA } = await pairedAgent(A, "Kitchen Pi", "TEST-AAAA"));
  ({ token: tokenB } = await pairedAgent(B, "B Pi", "TEST-BBBB"));
  [{ id: printerA }] = await db.select({ id: S.printers.id }).from(S.printers).where(eq(S.printers.tenantId, A));
});
after(async () => {
  for (const id of [A, B]) await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, id));
  for (const id of [A, B]) await db.delete(S.organization).where(eq(S.organization.id, id));
  process.exit(0);
});

test("pairing: a code works once, bad / expired codes are refused, the printer is registered", async () => {
  assert.equal((await call("pair", "POST", null, { code: "TEST-AAAA", devices: [] })).status, 403, "code already used");
  assert.equal((await call("pair", "POST", null, { code: "NOPE-NOPE" })).status, 403);
  await db.insert(S.printAgents).values({ tenantId: A, name: "old", pairingCodeHash: AG.hashCode("OLD0-CODE"), pairingExpiresAt: new Date(Date.now() - 1000) });
  assert.equal((await call("pair", "POST", null, { code: "OLD0-CODE" })).status, 403, "expired");
  const [p] = await db.select().from(S.printers).where(eq(S.printers.tenantId, A));
  assert.deepEqual([p.deviceKey, p.agentId, p.name], ["lp0", agentA, "Kitchen"]);
  const [a] = await db.select().from(S.printAgents).where(eq(S.printAgents.id, agentA));
  assert.ok(a.tokenHash && a.tokenHash !== tokenA, "token stored hashed");
  assert.equal(a.pairingCodeHash, null);
  assert.equal(a.lanIp, "192.168.1.47");
});

test("no token, a wrong token or a revoked agent is refused", async () => {
  assert.equal((await call("poll", "GET", null)).status, 401);
  assert.equal((await call("poll", "GET", "opa_wrong")).status, 401);
  const x = await pairedAgent(A, "temp", "TEMP-CODE", []);
  assert.equal((await poll(x.token)).status, 204);
  await db.update(S.printAgents).set({ revokedAt: new Date() }).where(eq(S.printAgents.id, x.id));
  assert.equal((await call("poll", "GET", x.token)).status, 401);
});

test("poll hands out a ticket once, the image is served, the result closes it", async () => {
  const job = await newJob(A);
  const r = await pollWith(tokenA, 0);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body!.type, r.body!.job.id, r.body!.job.device, r.body!.job.copies, r.body!.job.kind], ["job", job.id, "lp0", 1, "new"]);
  assert.equal((await pollWith(tokenA, 0)).status, 204, "leased: not handed out again");
  const img = await call("jobs/[id]/image", "GET", tokenA, undefined, { id: job.id });
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.deepEqual([...Buffer.from(await img.arrayBuffer()).subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal((await call("jobs/[id]/result", "POST", tokenA, { ok: true }, { id: job.id })).status, 200);
  const [done] = await db.select().from(S.printJobs).where(eq(S.printJobs.id, job.id));
  assert.equal(done.status, "done");
  assert.ok(done.printedAt);
  assert.equal((await call("jobs/[id]/result", "POST", tokenA, { ok: true }, { id: job.id })).status, 404, "already closed");
});

test("an expired lease is handed out again; after 5 attempts the ticket fails; a failed print is retried", async () => {
  const job = await newJob(A);
  for (let i = 1; i <= 5; i++) {
    const r = await pollWith(tokenA, 0);
    assert.equal(r.body?.job.id, job.id, `attempt ${i}`);
    await db.update(S.printJobs).set({ leasedUntil: new Date(Date.now() - 1000) }).where(eq(S.printJobs.id, job.id));
  }
  assert.equal((await pollWith(tokenA, 0)).status, 204, "given up");
  const [dead] = await db.select().from(S.printJobs).where(eq(S.printJobs.id, job.id));
  assert.equal(dead.status, "failed");
  assert.equal(dead.attempts, 5);

  const job2 = await newJob(A);
  assert.equal((await pollWith(tokenA, 0)).body!.job.id, job2.id);
  await call("jobs/[id]/result", "POST", tokenA, { ok: false, error: "paper out" }, { id: job2.id });
  const [retry] = await db.select().from(S.printJobs).where(eq(S.printJobs.id, job2.id));
  assert.deepEqual([retry.status, retry.error], ["pending", "paper out"]);
  assert.equal((await pollWith(tokenA, 0)).body!.job.id, job2.id, "handed out again");
  await call("jobs/[id]/result", "POST", tokenA, { ok: true }, { id: job2.id });
});

test("an agent never sees, downloads or closes another restaurant's ticket", async () => {
  const jobB = await newJob(B);
  assert.equal((await pollWith(tokenA, 0)).status, 204);
  assert.equal((await call("jobs/[id]/image", "GET", tokenA, undefined, { id: jobB.id })).status, 404);
  assert.equal((await call("jobs/[id]/result", "POST", tokenA, { ok: true }, { id: jobB.id })).status, 404);
  assert.equal((await pollWith(tokenB, 0)).body!.job.id, jobB.id);
  await call("jobs/[id]/result", "POST", tokenB, { ok: true }, { id: jobB.id });
});

test("a ticket for a disabled printer is not handed out", async () => {
  await db.update(S.printers).set({ enabled: false }).where(eq(S.printers.id, printerA));
  const [o] = await db.insert(S.orders).values({ tenantId: A, orderNumber: ++n }).returning();
  const [j] = await db.insert(S.printJobs).values({ tenantId: A, printerId: printerA, orderId: o.id, kind: "new", ticket: { kind: "new", restaurant: "x", orderNumber: 1, pickup: "ASAP", placedAt: "1:00 PM", lines: [], totalCents: 0 }, image: Buffer.from([1]), dedupeKey: randomUUID() }).returning();
  assert.equal((await pollWith(tokenA, 0)).status, 204);
  await db.update(S.printers).set({ enabled: true }).where(eq(S.printers.id, printerA));
  assert.equal((await pollWith(tokenA, 0)).body!.job.id, j.id);
  await call("jobs/[id]/result", "POST", tokenA, { ok: true }, { id: j.id });
});

test("a new ticket wakes a waiting poll within about a second (LISTEN/NOTIFY)", async () => {
  const t0 = Date.now();
  const waiting = pollWith(tokenA, 10);
  await new Promise((r) => setTimeout(r, 500));
  const job = await newJob(A);
  const r = await waiting;
  assert.equal(r.body?.job.id, job.id);
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  await call("jobs/[id]/result", "POST", tokenA, { ok: true }, { id: job.id });
});

test("heartbeat stores the Pi's details and the printer status; unknown devices appear", async () => {
  const r = await call("heartbeat", "POST", tokenA, {
    version: "0.2.0", hostname: "kitchen-pi", lan_ip: "192.168.1.50", info: { uptime: 100 },
    printers: [{ key: "lp0", online: false, paper_out: true }, { key: "lp1", online: true }],
  });
  assert.equal(r.status, 200);
  const [a] = await db.select().from(S.printAgents).where(eq(S.printAgents.id, agentA));
  assert.deepEqual([a.version, a.hostname, a.lanIp], ["0.2.0", "kitchen-pi", "192.168.1.50"]);
  assert.ok(AG.isOnline(a.lastSeenAt));
  const ps = await db.select().from(S.printers).where(eq(S.printers.tenantId, A));
  assert.equal(ps.find((p) => p.deviceKey === "lp0")?.lastStatus?.paperOut, true);
  assert.ok(ps.some((p) => p.deviceKey === "lp1"));
  await db.delete(S.printers).where(and(eq(S.printers.tenantId, A), eq(S.printers.deviceKey, "lp1"))); // keep one printer for the later tests
  assert.equal((await call("heartbeat", "POST", tokenA, { printers: "bad" })).status, 400);
});

test("service commands: allow-list, queued once, delivered first, result stored, audited, never to another restaurant", async () => {
  current = A;
  assert.equal((await actions.sendAgentCommand(agentA, "rm -rf /")).ok, false, "not on the allow-list");
  assert.equal(Q.isAgentCommand("sh"), false);
  assert.equal((await actions.sendAgentCommand(agentA, "show-log")).ok, true);
  assert.equal((await actions.sendAgentCommand(agentA, "show-log")).ok, false, "duplicate while waiting");
  await newJob(A); // a ticket is waiting too: the command still comes first
  assert.equal((await pollWith(tokenB, 0)).body?.type === "command", false, "B's agent never gets A's command");
  const r = await pollWith(tokenA, 0);
  assert.deepEqual([r.body!.type, r.body!.command.command], ["command", "show-log"]);
  assert.equal((await call("commands/[id]/result", "POST", tokenB, { ok: true }, { id: r.body!.command.id })).status, 404);
  assert.equal((await call("commands/[id]/result", "POST", tokenA, { ok: true, output: "line1\nline2" }, { id: r.body!.command.id })).status, 200);
  const [c] = await db.select().from(S.printAgentCommands).where(eq(S.printAgentCommands.id, r.body!.command.id));
  assert.deepEqual([c.status, c.result, c.requestedBy], ["done", "line1\nline2", "owner@x"]);
  const logged = await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, A), eq(S.auditLogs.action, "print.command")));
  assert.equal(logged.length, 1);
  // the waiting ticket is next
  assert.equal((await pollWith(tokenA, 0)).body!.type, "job");
});

test("a command the agent does not collect in time expires; too many are refused", async () => {
  current = A;
  await db.delete(S.printAgentCommands).where(eq(S.printAgentCommands.agentId, agentA));
  await db.insert(S.printAgentCommands).values({ tenantId: A, agentId: agentA, command: "update", createdAt: new Date(Date.now() - 6 * 60_000) });
  assert.notEqual((await pollWith(tokenA, 0)).body?.type, "command");
  const [c] = await db.select().from(S.printAgentCommands).where(eq(S.printAgentCommands.agentId, agentA));
  assert.equal(c.status, "expired");
  const cmds = Object.keys(Q.AGENT_COMMANDS);
  let refused = 0;
  for (let i = 0; i < 12; i++) {
    const r = await actions.sendAgentCommand(agentA, cmds[i % cmds.length]);
    if (!r.ok) refused++;
    await db.update(S.printAgentCommands).set({ status: "done" }).where(eq(S.printAgentCommands.agentId, agentA));
  }
  assert.ok(refused >= 1, "rate limit");
});

test("owner flow: pairing code from the dashboard action pairs an agent; revoke cuts it off", async () => {
  current = A;
  const made = await actions.createPrintAgent("Bar");
  assert.ok(made.ok);
  if (!made.ok) return;
  const r = await call("pair", "POST", null, { code: made.code.toLowerCase(), devices: [] });
  assert.equal(r.status, 200, "codes are case-insensitive");
  const { token, agent_id } = (await r.json()) as { token: string; agent_id: string };
  assert.equal((await poll(token)).status, 204);
  assert.equal((await actions.revokePrintAgent(agent_id)).ok, true);
  assert.equal((await call("poll", "GET", token)).status, 401);
});

test("update: agents are told which version to run only when the platform configured one", async () => {
  delete process.env.PRINT_AGENT_VERSION;
  delete process.env.PRINT_AGENT_BASE_URL;
  assert.equal((await call("update", "GET", tokenA)).status, 204);
  assert.equal((await call("update", "GET", null)).status, 401);
  process.env.PRINT_AGENT_VERSION = "1.2.0";
  process.env.PRINT_AGENT_BASE_URL = "https://github.com/x/y/releases/download/printer-v1.2.0/";
  try {
    const r = await call("update", "GET", tokenA);
    assert.deepEqual(await r.json(), { version: "1.2.0", base_url: "https://github.com/x/y/releases/download/printer-v1.2.0" });
  } finally {
    delete process.env.PRINT_AGENT_VERSION;
    delete process.env.PRINT_AGENT_BASE_URL;
  }
});

test("the setup-ticket command is on the allow-list", async () => {
  current = A;
  await db.delete(S.printAgentCommands).where(eq(S.printAgentCommands.agentId, agentA)); // clear the rate-limit window
  assert.equal(Q.isAgentCommand("setup-ticket"), true);
  assert.equal((await actions.sendAgentCommand(agentA, "setup-ticket")).ok, true);
});

test("SD-card setup files: a 7-day code that pairs, no secrets stored or logged", async () => {
  current = A;
  const input = { name: "Bar Pi", hostname: "bar-pi", ssid: "Cafe WiFi", wifiPassword: "correct horse battery", country: "US" };
  delete process.env.PRINT_AGENT_BASE_URL;
  const refused = await actions.createSetupFiles(input);
  assert.equal(refused.ok, false, "not available until the agent release is published");

  process.env.PRINT_AGENT_BASE_URL = "https://github.com/o/r/releases/download/printer-v1.0.0";
  process.env.PRINT_AGENT_VERSION = "1.0.0";
  process.env.BETTER_AUTH_URL = "https://orders.example.com";
  try {
    assert.equal((await actions.createSetupFiles({ ...input, hostname: "Bad Host" })).ok, false);
    assert.equal((await actions.createSetupFiles({ ...input, wifiPassword: "short" })).ok, false);
    const r = await actions.createSetupFiles(input);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.files.map((f) => f.name), ["user-data", "network-config"]);
    const userData = r.files[0].content;
    const code = /CODE=([A-Z0-9-]+)/.exec(userData)![1];
    assert.match(userData, /SERVER=https:\/\/orders\.example\.com/);
    assert.ok(!r.files.some((f) => f.content.includes(input.wifiPassword)), "plain Wi-Fi password in a file");

    const [agent] = await db.select().from(S.printAgents).where(eq(S.printAgents.name, "Bar Pi"));
    assert.ok(agent.pairingExpiresAt!.getTime() > Date.now() + 6 * 86_400_000, "code lives about 7 days");
    const logged = JSON.stringify(await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, A), eq(S.auditLogs.entityId, agent.id))));
    assert.ok(!logged.includes(input.wifiPassword) && !logged.includes(code), "secret in the audit log");

    // the code in the file is the one the Pi will use at first boot
    const paired = await call("pair", "POST", null, { code, devices: [] });
    assert.equal(paired.status, 200);
  } finally {
    delete process.env.PRINT_AGENT_BASE_URL;
    delete process.env.PRINT_AGENT_VERSION;
  }
});

test("a revoked (or never paired) agent can be deleted with its printers and tickets; an active one cannot", async () => {
  current = A;
  const live = await pairedAgent(A, "Live Pi", "LIVE-CODE", [{ key: "lp0" }]);
  assert.deepEqual(await actions.deletePrintAgent(live.id), { ok: false, error: "Revoke the agent first" });
  const [printer] = await db.select().from(S.printers).where(eq(S.printers.agentId, live.id));
  assert.ok(printer, "its printer exists");
  const [o] = await db.insert(S.orders).values({ tenantId: A, orderNumber: ++n }).returning();
  const [job] = await db.insert(S.printJobs).values({ tenantId: A, printerId: printer.id, orderId: o.id, kind: "new", ticket: { kind: "new", restaurant: "x", orderNumber: 1, pickup: "ASAP", placedAt: "1:00 PM", lines: [], totalCents: 0 }, image: Buffer.from([1]), dedupeKey: randomUUID() }).returning();

  assert.equal((await actions.revokePrintAgent(live.id)).ok, true);
  assert.equal((await actions.deletePrintAgent(live.id)).ok, true);
  assert.equal((await db.select().from(S.printAgents).where(eq(S.printAgents.id, live.id))).length, 0);
  assert.equal((await db.select().from(S.printers).where(eq(S.printers.id, printer.id))).length, 0, "its printer goes too");
  assert.equal((await db.select().from(S.printJobs).where(eq(S.printJobs.id, job.id))).length, 0, "and its tickets");
  assert.equal((await db.select().from(S.orders).where(eq(S.orders.id, o.id))).length, 1, "the order itself stays");
  const logged = await db.select().from(S.auditLogs).where(and(eq(S.auditLogs.tenantId, A), eq(S.auditLogs.action, "print.agent_deleted")));
  assert.equal(logged.length, 1);
  assert.equal((await actions.deletePrintAgent(live.id)).ok, false, "already gone");

  // never paired: can be deleted straight away
  const made = await actions.createPrintAgent("Never paired");
  assert.ok(made.ok);
  const [fresh] = await db.select().from(S.printAgents).where(eq(S.printAgents.name, "Never paired"));
  assert.equal((await actions.deletePrintAgent(fresh.id)).ok, true);

  // another restaurant's agent is out of reach
  current = B;
  const [bAgent] = await db.select().from(S.printAgents).where(eq(S.printAgents.tenantId, B));
  current = A;
  assert.equal((await actions.deletePrintAgent(bAgent.id)).ok, false);
  assert.equal((await db.select().from(S.printAgents).where(eq(S.printAgents.id, bAgent.id))).length, 1);
});
