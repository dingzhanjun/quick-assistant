import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { admin, organization } from "better-auth/plugins";
import { db } from "../db";
import { enqueueEmail, kickJobs } from "./jobs";
import * as schema from "../db/schema";
import { audit, userActor } from "./audit";
import { authPolicy } from "./auth-policy";

// An organization == a restaurant tenant. `admin` role on a user == platform admin.
export const platformAdminEmails = (process.env.PLATFORM_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // Sessions last 7 days and refresh at most daily; password reset already revokes the other sessions.
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  // Rate limiting is explicit (not just the production default). The client IP comes from a header our proxy
  // sets: Caddy overwrites X-Forwarded-For with the real peer; behind a Cloudflare tunnel set
  // AUTH_IP_HEADER=cf-connecting-ip. Never trust a header the internet can set directly.
  rateLimit: {
    enabled: true,
    storage: "database", // shared by all web replicas (in-memory counters would be per process)
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 5 },
      "/forget-password": { window: 60, max: 5 },
      "/send-verification-email": { window: 60, max: 5 },
    },
  },
  advanced: { ipAddress: { ipAddressHeaders: [process.env.AUTH_IP_HEADER || "x-forwarded-for"] } },
  account: { accountLinking: { requireLocalEmailVerified: true } }, // never link Google into an unverified password account
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const email = typeof ctx.body?.email === "string" ? ctx.body.email : null;
      if (!email) return;
      if (ctx.path === "/sign-up/email") {
        // Someone may have pre-registered this address (unverified) to plant a password. A new sign-up
        // replaces any such unverified record; verified accounts are untouched.
        await authPolicy.discardUnverifiedUser(email);
      } else if (
        ctx.path === "/sign-in/email" &&
        (await authPolicy.isAdminEmail(email, platformAdminEmails)) &&
        !authPolicy.adminPasswordLoginAllowed(email, platformAdminEmails)
      ) {
        // Platform admins sign in with Google only (protected by their Google account's two-step login), unless the
        // operator set PLATFORM_ADMIN_PASSWORD to seed the first admin (then that listed email may use its password).
        throw new APIError("UNAUTHORIZED", { message: "Invalid email or password" });
      }
    }),
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      // Not awaited so response time doesn't reveal whether the address exists.
      void enqueueEmail({ to: user.email, subject: "Reset your Quick Assistant password", text: `Click to choose a new password:\n\n${url}\n\nIf you didn't request this, ignore this message.` }).then(kickJobs).catch((e) => console.error(e));
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      // Not awaited so response time doesn't reveal whether the address exists.
      void enqueueEmail({ to: user.email, subject: "Verify your email for Quick Assistant", text: `Click to verify your email:\n\n${url}\n\nIf you didn't sign up, ignore this message.` }).then(kickJobs).catch((e) => console.error(e));
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          const [u] = await db.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, session.userId));
          if (u) await audit({ action: "auth.sign_in", actor: userActor(u), entityType: "user", entityId: u.id, summary: `${u.email} signed in` });
        },
      },
    },
    user: {
      create: {
        // Emails in PLATFORM_ADMIN_EMAILS become platform admins on first sign-in.
        before: async (user) => {
          const isAdminEmail = platformAdminEmails.includes(user.email.toLowerCase());
          if (!isAdminEmail) return { data: user };
          // Admin emails must come in via Google (verified). Blocking password sign-up stops
          // someone pre-registering the address and later hijacking it through account linking.
          if (!user.emailVerified) {
            throw new APIError("BAD_REQUEST", { message: "Please sign in with Google." });
          }
          return { data: { ...user, role: "admin" } };
        },
      },
    },
  },
  plugins: [
    organization({
      invitationExpiresIn: 60 * 60 * 24 * 7,
      organizationHooks: {
        afterCreateOrganization: async ({ organization: org, user }) => {
          await audit({ action: "restaurant.created", actor: userActor(user), tenantId: org.id, entityType: "tenant", entityId: org.id, summary: `Restaurant "${org.name}" created` });
        },
        afterCreateInvitation: async ({ invitation, inviter, organization: org }) => {
          await audit({ action: "team.invited", actor: userActor(inviter), tenantId: org.id, entityType: "invitation", entityId: invitation.id, summary: `Invited ${invitation.email} as ${invitation.role === "member" ? "staff" : invitation.role}`, details: { email: invitation.email, role: invitation.role } });
        },
        afterCancelInvitation: async ({ invitation, cancelledBy, organization: org }) => {
          await audit({ action: "team.invitation_cancelled", actor: userActor(cancelledBy), tenantId: org.id, entityType: "invitation", entityId: invitation.id, summary: `Cancelled invitation for ${invitation.email}` });
        },
        afterAcceptInvitation: async ({ invitation, user, organization: org }) => {
          await audit({ action: "team.member_joined", actor: userActor(user), tenantId: org.id, entityType: "member", entityId: user.id, summary: `${user.email} joined as ${invitation.role === "member" ? "staff" : invitation.role}` });
        },
        afterRemoveMember: async ({ user, organization: org }) => {
          await audit({ action: "team.member_removed", actor: { type: "user", label: "restaurant owner" }, tenantId: org.id, entityType: "member", entityId: user.id, summary: `${user.email} removed from the team` });
        },
        afterUpdateMemberRole: async ({ user, previousRole, member, organization: org }) => {
          await audit({ action: "team.role_changed", actor: { type: "user", label: "restaurant owner" }, tenantId: org.id, entityType: "member", entityId: user.id, summary: `${user.email}: ${previousRole} -> ${member.role}`, details: { from: previousRole, to: member.role } });
        },
      },
      // Only owners (and the library's own admin role) may invite; invitees join as "member" = Staff.
      sendInvitationEmail: async ({ id, email, organization: org, inviter }) => {
        const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
        void enqueueEmail({ to: email, subject: `You're invited to ${org.name} on Quick Assistant`, text: `${inviter.user.name} invited you to join ${org.name} as staff.\n\nSign in (or create an account with this email address), then open:\n${base}/accept-invitation/${id}\n\nThe link works for 7 days.` }).then(kickJobs).catch((e) => console.error(e));
      },
    }),
    admin(),
    nextCookies(),
  ],
});
