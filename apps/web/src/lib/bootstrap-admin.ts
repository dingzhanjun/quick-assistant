import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { account, user } from "../db/schema";
import { audit } from "./audit";

// A brand-new system has no platform admin and nobody who can create one (admins normally sign in with Google). Setting
// PLATFORM_ADMIN_PASSWORD (with PLATFORM_ADMIN_EMAILS) seeds the FIRST admin at startup, with that password.
//   - only when no admin exists yet, and never touches an existing account with that email;
//   - the account is created verified, with the `admin` role and a normal password credential;
//   - password sign-in for admin emails works only while PLATFORM_ADMIN_PASSWORD is set (see authPolicy), so removing the
//     variable puts the system back to Google-only admins.
export const MIN_ADMIN_PASSWORD = 12;

export type BootstrapResult = "created" | "disabled" | "no_email" | "weak_password" | "admin_exists" | "user_exists";
type Env = Record<string, string | undefined>;

// `database` is only replaced by tests (a transaction they roll back).
export async function ensureBootstrapAdmin(env: Env = process.env, database: Pick<typeof db, "transaction"> = db): Promise<BootstrapResult> {
  const password = env.PLATFORM_ADMIN_PASSWORD;
  if (!password) return "disabled";
  const email = (env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)[0];
  if (!email) return "no_email";
  if (password.length < MIN_ADMIN_PASSWORD) {
    console.error(`[bootstrap] PLATFORM_ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD} characters: no admin was created`);
    return "weak_password";
  }

  const { auth } = await import("./auth"); // loaded here: it reads the environment and pulls in the whole auth library
  const hash = await (await auth.$context).password.hash(password); // the library's own format, so normal sign-in verifies it

  const result = await database.transaction(async (tx) => {
    // Several web replicas start at once: one creates the admin, the others see it and do nothing.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bootstrap-admin'))`);
    const [anyAdmin] = await tx.select({ id: user.id }).from(user).where(eq(user.role, "admin")).limit(1);
    if (anyAdmin) return { status: "admin_exists" as const };
    const [existing] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (existing) return { status: "user_exists" as const }; // already registered: never take it over
    const id = randomUUID();
    const now = new Date();
    await tx.insert(user).values({ id, name: "Platform admin", email, emailVerified: true, role: "admin", createdAt: now, updatedAt: now });
    await tx.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash, createdAt: now, updatedAt: now });
    return { status: "created" as const, id };
  });

  if (result.status === "created") {
    await audit({
      action: "admin.bootstrapped", actor: { type: "system", label: "startup" }, entityType: "user", entityId: result.id,
      summary: `First platform admin ${email} created from PLATFORM_ADMIN_EMAILS / PLATFORM_ADMIN_PASSWORD`,
    });
    console.log(`[bootstrap] platform admin ${email} created. Sign in with PLATFORM_ADMIN_PASSWORD, then set up Google sign-in and remove the variable.`);
  } else if (result.status === "admin_exists") {
    console.warn("[bootstrap] PLATFORM_ADMIN_PASSWORD is set: password sign-in is enabled for the platform admin emails. Remove it once you no longer need it.");
  }
  return result.status;
}
