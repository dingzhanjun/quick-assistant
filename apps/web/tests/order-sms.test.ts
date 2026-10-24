// Texting the customer a link to their order: number parsing, providers, and the agent endpoint's safety limits.
// Needs a migrated Postgres (DATABASE_URL); creates throwaway restaurants and removes them afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { orderLinkExpired, orderLinkUrl, orderSmsText, parseTextNumber, validOrderToken, newOrderToken } from "../src/lib/order-link";
import { sendSms, smsConfigured, smsProvider } from "../src/lib/sms";

process.env.AGENT_API_KEY = "test-agent-key";

test("numbers the caller says become E.164; junk is refused", () => {
  assert.equal(parseTextNumber("(404) 555-0123"), "+14045550123");
  assert.equal(parseTextNumber("1 404 555 0123"), "+14045550123");
  assert.equal(parseTextNumber("+1 404-555-0123"), "+14045550123");
  assert.equal(parseTextNumber("+44 7700 900123"), "+447700900123");
  for (const bad of ["12345678", "404555012", "0045550123", "555-0123", "abcdefghij", "+0123456789", "1404555012", "(104) 555-0123"]) {
    assert.equal(parseTextNumber(bad), null, bad);
  }
});

test("tokens are 22 url-safe characters and the link and message read well", () => {
  const t = newOrderToken();
  assert.ok(validOrderToken(t) && t.length === 22);
  assert.notEqual(newOrderToken(), t);
  assert.ok(!validOrderToken("short") && !validOrderToken(`${t}/`));
  assert.equal(orderLinkUrl("abc", "https://x.test/"), "https://x.test/orders/abc");
  const msg = orderSmsText({ orderNumber: 7, url: "https://x.test/orders/abc" });
  assert.equal(msg, "Thanks for your order, to view your order #7, tap this link: https://x.test/orders/abc");
  assert.ok(msg.length < 160, "one SMS segment");
  assert.equal(orderLinkExpired(new Date(Date.now() - 29 * 86_400_000)), false);
  assert.equal(orderLinkExpired(new Date(Date.now() - 31 * 86_400_000)), true);
});

test("providers: off unless fully configured, correct requests, errors are thrown", async () => {
  assert.equal(smsProvider({}), null);
  assert.equal(smsConfigured({ SMS_PROVIDER: "twilio" }), false, "twilio without credentials is off");
  assert.equal(smsProvider({ SMS_PROVIDER: "log" }), "log");

  const calls: { url: string; init: RequestInit }[] = [];
  const ok = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}", { status: 201 }); }) as unknown as typeof fetch;
  const twilio = { SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", SMS_FROM: "+15550001111" };
  await sendSms("+14045550123", "hello", twilio, ok);
  assert.equal(calls[0].url, "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
  assert.match(String(calls[0].init.body), /To=%2B14045550123/);
  assert.match(String(calls[0].init.body), /From=%2B15550001111/);
  await sendSms("+14045550123", "hello", { ...twilio, SMS_FROM: "MG123" }, ok);
  assert.match(String(calls[1].init.body), /MessagingServiceSid=MG123/);

  await sendSms("+14045550123", "hi", { SMS_PROVIDER: "plivo", PLIVO_AUTH_ID: "MA1", PLIVO_AUTH_TOKEN: "t", SMS_FROM: "+15550001111" }, ok); // written with a "+": Plivo gets digits only
  assert.equal(calls[2].url, "https://api.plivo.com/v1/Account/MA1/Message/");
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { src: "15550001111", dst: "14045550123", text: "hi" });

  const bad = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(sendSms("+14045550123", "x", twilio, bad), /twilio answered 400/);
  await assert.rejects(sendSms("+14045550123", "x", {}, ok), /not configured/);
});

// ---- the endpoint -----------------------------------------------------------------------------------------------
const run = randomUUID().slice(0, 8);
const A = `sms-a-${run}`, B = `sms-b-${run}`;
const NUM_A = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
const DEST = `+1404${Math.floor(1000000 + Math.random() * 8999999)}`;
type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");
let POST: (req: Request) => Promise<Response>;
let GET_MENU: (req: Request) => Promise<Response>;

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  ({ POST } = await import("../src/app/api/agent/orders/sms/route"));
  ({ GET: GET_MENU } = await import("../src/app/api/agent/menu/route"));
  for (const id of [A, B]) await db.insert(S.organization).values({ id, name: `Pizza ${id}`, slug: id, createdAt: new Date() });
  await db.insert(S.phoneNumbers).values({ e164: NUM_A, tenantId: A });
});
after(async () => {
  for (const id of [A, B]) await db.delete(S.auditLogs).where(eq(S.auditLogs.tenantId, id));
  await db.delete(S.jobs).where(sql`${S.jobs.payload}->>'tenantId' in (${A}, ${B})`);
  for (const id of [A, B]) await db.delete(S.organization).where(eq(S.organization.id, id));
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, NUM_A));
  process.exit(0);
});

const call = async (body: unknown, path = "orders/sms") =>
  (await POST(new Request(`http://t/api/agent/${path}`, { method: "POST", headers: { authorization: "Bearer test-agent-key", "content-type": "application/json" }, body: JSON.stringify(body) }))).json() as Promise<{ ok: boolean; reason?: string; duplicate?: boolean }>;
const mkOrder = async (tenant: string, n: number, extra: Partial<typeof S.orders.$inferInsert> = {}) =>
  (await db.insert(S.orders).values({ tenantId: tenant, orderNumber: n, customerName: "Pat", publicToken: newOrderToken(), ...extra }).returning())[0];
const jobsFor = (orderId: string) => db.select().from(S.jobs).where(eq(S.jobs.type, "sms")).then((r) => r.filter((j) => j.payload.orderId === orderId));

test("the endpoint needs the agent key and texting switched on", async () => {
  const res = await POST(new Request("http://t/x", { method: "POST", body: "{}" }));
  assert.equal(res.status, 401);
  const o = await mkOrder(A, 1);
  delete process.env.SMS_PROVIDER;
  assert.equal((await call({ to: NUM_A, order_number: 1, number: "404-555-0100" })).reason, "sms_off");
  process.env.SMS_PROVIDER = "log";
  await db.insert(S.tenantSettings).values({ tenantId: A, textOrderLink: false });
  assert.equal((await call({ to: NUM_A, order_number: 1, number: "404-555-0100" })).reason, "sms_off", "the restaurant turned it off");
  await db.update(S.tenantSettings).set({ textOrderLink: true }).where(eq(S.tenantSettings.tenantId, A));
  assert.equal((await jobsFor(o.id)).length, 0);
});

test("the menu tells the agent whether to offer texting", async () => {
  const get = async () => (await (await GET_MENU(new Request(`http://t/api/agent/menu?to=${encodeURIComponent(NUM_A)}`, { headers: { authorization: "Bearer test-agent-key" } }))).json()) as { text_orders: boolean };
  assert.equal((await get()).text_orders, true);
  await db.update(S.tenantSettings).set({ textOrderLink: false }).where(eq(S.tenantSettings.tenantId, A));
  assert.equal((await get()).text_orders, false);
  await db.update(S.tenantSettings).set({ textOrderLink: true }).where(eq(S.tenantSettings.tenantId, A));
  delete process.env.SMS_PROVIDER;
  assert.equal((await get()).text_orders, false, "no provider");
  process.env.SMS_PROVIDER = "log";
});

test("a request stores the number; the text goes out ONCE when the restaurant confirms", async () => {
  const { textOrderLink } = await import("../src/lib/order-sms");
  const o = await mkOrder(A, 2, { pickupAt: null });
  assert.deepEqual(await call({ to: NUM_A, order_number: 2, number: "(404) 555-0111" }), { ok: true });
  let [row] = await db.select().from(S.orders).where(eq(S.orders.id, o.id));
  assert.equal(row.contactNumber, "+14045550111");
  assert.equal(row.smsCount, 1);
  assert.equal(row.smsSentAt, null);
  assert.equal((await jobsFor(o.id)).length, 0, "nothing is sent while the order is still waiting for confirmation");
  // the same request again changes nothing
  assert.equal((await call({ to: NUM_A, order_number: 2, number: "404 555 0111" })).duplicate, true);

  // the restaurant confirms: ONE text with the link; a second confirmation (or a second replica) sends nothing
  assert.equal(await textOrderLink(A, o.id), true);
  assert.equal(await textOrderLink(A, o.id), false);
  const jobs = await jobsFor(o.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.to, "+14045550111");
  assert.equal(jobs[0].payload.text, `Thanks for your order, to view your order #2, tap this link: ${orderLinkUrl(o.publicToken!)}`);
  [row] = await db.select().from(S.orders).where(eq(S.orders.id, o.id));
  assert.ok(row.smsSentAt);

  // the customer corrects the number after that: it is sent once more, to the right phone, then the order is closed to more
  assert.deepEqual(await call({ to: NUM_A, order_number: 2, number: "404-555-0112" }), { ok: true });
  [row] = await db.select().from(S.orders).where(eq(S.orders.id, o.id));
  assert.equal(row.smsSentAt, null);
  assert.equal(await textOrderLink(A, o.id), true);
  assert.deepEqual((await jobsFor(o.id)).map((j) => j.payload.to).sort(), ["+14045550111", "+14045550112"]);
  assert.equal((await call({ to: NUM_A, order_number: 2, number: "404-555-0113" })).reason, "order_limit");

  const audits = await db.select().from(S.auditLogs).where(eq(S.auditLogs.tenantId, A));
  assert.equal(audits.filter((a) => a.action === "order.text_requested").length, 2);
  assert.equal(audits.filter((a) => a.action === "order.text_sent").length, 2);
  assert.ok(audits.every((a) => !JSON.stringify(a).includes("5550111")), "numbers are masked in the audit trail");
});

test("an order that was already confirmed gets its text at once; cancelled, number-less or opted-out orders get none", async () => {
  const { textOrderLink } = await import("../src/lib/order-sms");
  // confirmed while the customer was still on the line, then they give the number
  const confirmed = await mkOrder(A, 20, { status: "preparing" });
  assert.deepEqual(await call({ to: NUM_A, order_number: 20, number: "404-555-0120" }), { ok: true });
  assert.equal((await jobsFor(confirmed.id)).length, 1);

  const noNumber = await mkOrder(A, 21);
  assert.equal(await textOrderLink(A, noNumber.id), false);
  assert.equal((await jobsFor(noNumber.id)).length, 0);

  const cancelled = await mkOrder(A, 22, { contactNumber: "+14045550122", smsCount: 1 });
  await db.update(S.orders).set({ status: "cancelled" }).where(eq(S.orders.id, cancelled.id));
  assert.equal(await textOrderLink(A, cancelled.id), false);

  const optedOut = await mkOrder(A, 23, { contactNumber: "+14045550123", smsCount: 1 });
  await db.update(S.tenantSettings).set({ textOrderLink: false }).where(eq(S.tenantSettings.tenantId, A));
  assert.equal(await textOrderLink(A, optedOut.id), false, "the restaurant turned texting off after the call");
  await db.update(S.tenantSettings).set({ textOrderLink: true }).where(eq(S.tenantSettings.tenantId, A));
  assert.equal(await textOrderLink(A, optedOut.id), true);
});

test("refusals: bad number, cancelled, old, unknown, and another restaurant's order", async () => {
  await mkOrder(A, 3);
  assert.equal((await call({ to: NUM_A, order_number: 3, number: "12345678" })).reason, "bad_number");
  await mkOrder(A, 4, { status: "cancelled" });
  assert.equal((await call({ to: NUM_A, order_number: 4, number: "404-555-0120" })).reason, "no_order");
  await mkOrder(A, 5, { createdAt: new Date(Date.now() - 45 * 60_000) });
  assert.equal((await call({ to: NUM_A, order_number: 5, number: "404-555-0120" })).reason, "too_old");
  assert.equal((await call({ to: NUM_A, order_number: 999, number: "404-555-0120" })).reason, "no_order");
  const theirs = await mkOrder(B, 77); // only restaurant B has an order #77
  assert.equal((await call({ to: NUM_A, order_number: 77, number: "404-555-0121" })).reason, "no_order");
  const [still] = await db.select().from(S.orders).where(eq(S.orders.id, theirs.id));
  assert.equal(still.smsCount, 0, "B's order was never touched");
});

test("one destination number gets at most 3 order texts a day, across restaurants", async () => {
  for (let n = 10; n < 13; n++) {
    await mkOrder(A, n);
    assert.equal((await call({ to: NUM_A, order_number: n, number: DEST })).ok, true, `text ${n - 9}`);
  }
  await mkOrder(A, 13);
  assert.equal((await call({ to: NUM_A, order_number: 13, number: DEST })).reason, "number_limit");
  assert.equal((await jobsFor((await db.select().from(S.orders).where(and(eq(S.orders.tenantId, A), eq(S.orders.orderNumber, 13))))[0].id)).length, 0);
});
