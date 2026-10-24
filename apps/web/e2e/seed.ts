import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq, inArray, like, or } from "drizzle-orm";

export const STATE_FILE = path.join(__dirname, ".state.json");
type Creds = { email: string; password: string };

// Run with tsx (Playwright's own loader cannot import the ESM-only auth library): `tsx e2e/seed.ts setup|teardown`.
// Creates one restaurant with an owner and a staff member (verified, password sign-in) and a phone number.
async function setup() {
  // Same env the server loads (next.config.ts reads the root .env), or the signed admin cookie would not verify.
  (await import("dotenv")).config({ path: path.join(__dirname, "../../../.env") });
  process.env.BETTER_AUTH_SECRET ??= "e2e-secret";
  process.env.BETTER_AUTH_URL = "http://localhost:3100";
  process.env.GOOGLE_CLIENT_ID ??= "e2e";
  process.env.GOOGLE_CLIENT_SECRET ??= "e2e";
  const { db } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { auth } = await import("../src/lib/auth");

  const run = randomUUID().slice(0, 8);
  const tenantId = `e2e-${run}`;
  const number = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
  const mk = (role: string): Creds => ({ email: `${role}-${run}@e2e.test`, password: `pw-${run}-secret` });
  const owner = mk("owner"), staff = mk("staff");

  await db.insert(S.organization).values({ id: tenantId, name: `E2E Diner ${run}`, slug: tenantId, createdAt: new Date() });
  for (const [creds, role, name] of [[owner, "owner", "Olivia Owner"], [staff, "member", "Sam Staff"]] as const) {
    const res = await auth.api.signUpEmail({ body: { name, email: creds.email, password: creds.password } });
    await db.update(S.user).set({ emailVerified: true }).where(eq(S.user.id, res.user.id));
    await db.insert(S.member).values({ id: randomUUID(), organizationId: tenantId, userId: res.user.id, role, createdAt: new Date() });
  }
  await db.insert(S.phoneNumbers).values({ e164: number, tenantId });

  // A platform admin. Admins cannot use password sign-in (by design), so mint a session and sign its cookie
  // the way Better Auth does (value = token + "." + base64(HMAC-SHA256(secret, token))).
  const adminEmail = `admin-${run}@e2e.test`;
  const adminRes = await auth.api.signUpEmail({ body: { name: "Ada Admin", email: adminEmail, password: `pw-${run}-secret` } });
  await db.update(S.user).set({ emailVerified: true, role: "admin" }).where(eq(S.user.id, adminRes.user.id));
  const ctx = await auth.$context;
  const adminSession = await ctx.internalAdapter.createSession(adminRes.user.id);
  const sig = createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(adminSession.token).digest("base64");
  const adminCookie = encodeURIComponent(`${adminSession.token}.${sig}`);

  const [dish] = await db.insert(S.menuItems).values({ tenantId, name: `Soup ${run}`, priceCents: 600 }).returning();
  const state = { run, tenantId, number, owner, staff, agentKey: process.env.AGENT_API_KEY ?? "e2e-agent-key", dishId: dish.id, adminEmail, adminCookie };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));

}

async function teardown() {
  const { run, tenantId, number } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const { db } = await import("../src/db");
  const S = await import("../src/db/schema");
  const users = await db.select({ id: S.user.id }).from(S.user).where(like(S.user.email, `%-${run}@e2e.test`));
  await db.delete(S.phoneNumbers).where(eq(S.phoneNumbers.e164, number));
  await db.delete(S.organization).where(eq(S.organization.id, tenantId));
  if (users.length) await db.delete(S.user).where(inArray(S.user.id, users.map((u) => u.id)));
  // The audit trail has no foreign keys (it must outlive deleted restaurants), so remove this run's entries.
  await db.delete(S.auditLogs).where(or(eq(S.auditLogs.tenantId, tenantId), like(S.auditLogs.actorLabel, `%-${run}@e2e.test`)));
  fs.rmSync(STATE_FILE, { force: true });
}

(process.argv[2] === "teardown" ? teardown() : setup())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
