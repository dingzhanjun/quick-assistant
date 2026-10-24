import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { user } from "../db/schema";

// Account-security rules that don't depend on the auth library, kept separate so they can be tested.
export const authPolicy = {
  // Admins sign in with Google only, EXCEPT when the operator opted in by setting PLATFORM_ADMIN_PASSWORD (the seeded first
  // admin, see bootstrap-admin.ts): then a listed admin email may use its password. Unset the variable to switch it off again.
  adminPasswordLoginAllowed(email: string, adminEmails: string[], env: Record<string, string | undefined> = process.env): boolean {
    return !!env.PLATFORM_ADMIN_PASSWORD && adminEmails.includes(email.trim().toLowerCase());
  },

  // Platform admin = listed in PLATFORM_ADMIN_EMAILS or has the `admin` role.
  async isAdminEmail(email: string, adminEmails: string[]): Promise<boolean> {
    const e = email.trim().toLowerCase();
    if (adminEmails.includes(e)) return true;
    const [u] = await db.select({ role: user.role }).from(user).where(eq(user.email, e));
    return u?.role === "admin";
  },

  // Deletes an UNVERIFIED user with this email (cascades to its accounts/sessions). Returns whether one existed.
  async discardUnverifiedUser(email: string): Promise<boolean> {
    const deleted = await db
      .delete(user)
      .where(and(eq(user.email, email.trim().toLowerCase()), eq(user.emailVerified, false)))
      .returning({ id: user.id });
    return deleted.length > 0;
  },
};
