// Seeding the first platform admin from PLATFORM_ADMIN_EMAILS + PLATFORM_ADMIN_PASSWORD (brand-new system).
// Needs a migrated Postgres (DATABASE_URL). The creation cases run inside a transaction that is rolled back, so the
// developer's real admin accounts are never touched.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq, like } from "drizzle-orm";

const run = randomUUID().slice(0, 8);
const BOSS = `boss-${run}@example.com`;
process.env.PLATFORM_ADMIN_EMAILS = `${BOSS}, second-${run}@example.com`;
delete process.env.PLATFORM_ADMIN_PASSWORD;
const PASSWORD = "correct-horse-battery";

class Rollback extends Error {}
type Tx = Parameters<Parameters<(typeof import("../src/db"))["db"]["transaction"]>[0]>[0];
async function load() {
  const { db } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { ensureBootstrapAdmin } = await import("../src/lib/bootstrap-admin");
  const { auth } = await import("../src/lib/auth");
  return { db, S, ensureBootstrapAdmin, auth };
}
// Runs `fn` in a transaction with NO admins in it, then rolls everything back.
async function inEmptySystem(fn: (tx: Tx, t: Awaited<ReturnType<typeof load>>) => Promise<void>) {
  const t = await load();
  await assert.rejects(
    t.db.transaction(async (tx) => {
      await tx.update(t.S.user).set({ role: null }).where(eq(t.S.user.role, "admin")); // "brand new": nobody is admin
      await fn(tx, t);
      throw new Rollback();
    }),
    Rollback,
  );
}

after(async () => {
  const { db, S } = await load();
  await db.delete(S.auditLogs).where(eq(S.auditLogs.action, "admin.bootstrapped"));
  await db.delete(S.user).where(like(S.user.email, `%-${run}@example.com`));
  process.exit(0);
});

test("nothing happens without the password, without an email, or with a weak password", async () => {
  const { ensureBootstrapAdmin } = await load();
  assert.equal(await ensureBootstrapAdmin({ PLATFORM_ADMIN_EMAILS: BOSS }), "disabled");
  assert.equal(await ensureBootstrapAdmin({ PLATFORM_ADMIN_PASSWORD: PASSWORD }), "no_email");
  assert.equal(await ensureBootstrapAdmin({ PLATFORM_ADMIN_EMAILS: BOSS, PLATFORM_ADMIN_PASSWORD: "short-pass" }), "weak_password");
  const { db, S } = await load();
  assert.equal((await db.select().from(S.user).where(eq(S.user.email, BOSS))).length, 0);
});

test("a brand-new system gets a verified admin with a password that signs in; a second start does nothing", async () => {
  await inEmptySystem(async (tx, { S, ensureBootstrapAdmin, auth }) => {
    const env = { PLATFORM_ADMIN_EMAILS: `${BOSS}, second-${run}@example.com`, PLATFORM_ADMIN_PASSWORD: PASSWORD };
    assert.equal(await ensureBootstrapAdmin(env, tx), "created");
    const [u] = await tx.select().from(S.user).where(eq(S.user.email, BOSS)); // the FIRST listed email
    assert.equal(u.role, "admin");
    assert.equal(u.emailVerified, true);
    const [acc] = await tx.select().from(S.account).where(eq(S.account.userId, u.id));
    assert.equal(acc.providerId, "credential");
    assert.notEqual(acc.password, PASSWORD, "the password is stored hashed");
    const ctx = await auth.$context;
    assert.equal(await ctx.password.verify({ hash: acc.password!, password: PASSWORD }), true);
    assert.equal(await ctx.password.verify({ hash: acc.password!, password: "wrong-password-123" }), false);
    assert.equal((await tx.select().from(S.user).where(eq(S.user.email, `second-${run}@example.com`))).length, 0, "only one admin is seeded");
    // restart: an admin exists now
    assert.equal(await ensureBootstrapAdmin(env, tx), "admin_exists");
    assert.equal((await tx.select().from(S.user).where(eq(S.user.role, "admin"))).length, 1);
  });
});

test("an existing admin means no seeding, and an existing account with that email is never taken over", async () => {
  const env = { PLATFORM_ADMIN_EMAILS: BOSS, PLATFORM_ADMIN_PASSWORD: PASSWORD };
  await inEmptySystem(async (tx, { S, ensureBootstrapAdmin }) => {
    const now = new Date();
    await tx.insert(S.user).values({ id: `a-${run}`, name: "Other", email: `other-${run}@example.com`, emailVerified: true, role: "admin", createdAt: now, updatedAt: now });
    assert.equal(await ensureBootstrapAdmin(env, tx), "admin_exists");
    assert.equal((await tx.select().from(S.user).where(eq(S.user.email, BOSS))).length, 0);
  });
  await inEmptySystem(async (tx, { S, ensureBootstrapAdmin }) => {
    const now = new Date();
    await tx.insert(S.user).values({ id: `u-${run}`, name: "Squatter", email: BOSS, emailVerified: false, createdAt: now, updatedAt: now });
    assert.equal(await ensureBootstrapAdmin(env, tx), "user_exists");
    const [u] = await tx.select().from(S.user).where(eq(S.user.email, BOSS));
    assert.equal(u.role, null, "not promoted");
    assert.equal((await tx.select().from(S.account).where(eq(S.account.userId, u.id))).length, 0, "no password planted");
  });
});

test("password sign-in for admins works only while PLATFORM_ADMIN_PASSWORD is set, and only for listed emails", async () => {
  const { db, S, auth } = await load();
  const hash = await (await auth.$context).password.hash(PASSWORD);
  const now = new Date();
  const mk = async (email: string) => {
    const id = randomUUID();
    await db.insert(S.user).values({ id, name: "Admin", email, emailVerified: true, role: "admin", createdAt: now, updatedAt: now });
    await db.insert(S.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash, createdAt: now, updatedAt: now });
  };
  await mk(BOSS);
  await mk(`unlisted-${run}@example.com`); // an admin by role, but not in PLATFORM_ADMIN_EMAILS
  const signIn = (email: string, password: string, ip: string) =>
    auth.handler(new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password }),
    }));

  delete process.env.PLATFORM_ADMIN_PASSWORD;
  assert.equal((await signIn(BOSS, PASSWORD, "192.0.2.61")).status, 401, "Google only while the variable is unset");

  process.env.PLATFORM_ADMIN_PASSWORD = PASSWORD;
  try {
    assert.equal((await signIn(BOSS, PASSWORD, "192.0.2.62")).status, 200, "the seeded admin signs in with the password");
    assert.equal((await signIn(BOSS, "wrong-password-123", "192.0.2.63")).status, 401);
    assert.equal((await signIn(`unlisted-${run}@example.com`, PASSWORD, "192.0.2.64")).status, 401, "an unlisted admin stays Google-only");
  } finally {
    delete process.env.PLATFORM_ADMIN_PASSWORD;
  }
});
