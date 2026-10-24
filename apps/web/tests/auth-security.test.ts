// Auth hardening (LAUNCH_PLAN P3.1) against a migrated Postgres.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq, like } from "drizzle-orm";

process.env.PLATFORM_ADMIN_EMAILS = "boss-test@example.com";
const run = randomUUID().slice(0, 8);

async function setup() {
  const { auth } = await import("../src/lib/auth");
  const { db } = await import("../src/db");
  const S = await import("../src/db/schema");
  return { auth, db, S };
}

const post = (auth: { handler: (r: Request) => Promise<Response> }, path: string, body: unknown, ip: string) =>
  auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );

after(async () => {
  const { db, S } = await setup();
  await db.delete(S.auditLogs).where(like(S.auditLogs.actorLabel, `%${run}@example.com`));
  await db.delete(S.user).where(like(S.user.email, `%${run}@example.com`));
  process.exit(0);
});

test("the 11th sign-in attempt from one address inside a minute is refused", async () => {
  const { auth } = await setup();
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) {
    codes.push((await post(auth, "/sign-in/email", { email: `nobody-${run}@example.com`, password: "wrong-password" }, ip)).status);
  }
  assert.ok(codes.slice(0, 10).every((c) => c !== 429), `early attempts limited: ${codes}`);
  assert.equal(codes[10], 429);
  // another address has its own bucket
  const other = await post(auth, "/sign-in/email", { email: `nobody-${run}@example.com`, password: "x" }, "198.51.100.7");
  assert.notEqual(other.status, 429);
});

test("an admin email cannot use password sign-in", async () => {
  const { auth, db, S } = await setup();
  await db.insert(S.user).values({ id: `u-${run}`, name: "Boss", email: "boss-test@example.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  const res = await post(auth, "/sign-in/email", { email: "boss-test@example.com", password: "whatever-123" }, "192.0.2.50");
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Invalid email or password/);
  await db.delete(S.user).where(eq(S.user.email, "boss-test@example.com"));
});

test("signing up over an unverified pre-registration replaces it; verified accounts survive", async () => {
  const { authPolicy } = await import("../src/lib/auth-policy");
  const { db, S } = await setup();
  const mk = (n: string, verified: boolean) =>
    db.insert(S.user).values({ id: `${n}-${run}`, name: n, email: `${n}-${run}@example.com`, emailVerified: verified, createdAt: new Date(), updatedAt: new Date() });
  await mk("squat", false);
  await mk("real", true);
  assert.equal(await authPolicy.discardUnverifiedUser(`squat-${run}@example.com`), true);
  assert.equal(await authPolicy.discardUnverifiedUser(`real-${run}@example.com`), false);
  const left = await db.select().from(S.user).where(like(S.user.email, `%-${run}@example.com`));
  assert.deepEqual(left.map((u) => u.name), ["real"]);
});

test("rate limit counters live in the database, so every web replica shares them", async () => {
  const { auth, db, S } = await setup();
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  await post(auth, "/sign-in/email", { email: `nobody-${run}@example.com`, password: "wrong-password" }, ip);
  const rows = await db.select().from(S.rateLimit);
  assert.ok(rows.some((r) => r.key.includes(ip)), "no rate limit row was written for this client address");
  await db.delete(S.rateLimit).where(like(S.rateLimit.key, `%${ip}%`));
});
