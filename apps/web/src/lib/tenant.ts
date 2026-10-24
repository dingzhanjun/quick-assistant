import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { member } from "@/db/schema";
import { auth } from "./auth";

// Resolves the signed-in user's restaurant. Uses the session's active organization (if still a member), falling back
// to the user's first membership (a fresh sign-in has no active organization set). Returns where to send the visitor
// when there is none, so callers that cannot redirect (API routes) can answer 401 instead.
// Call only in request scope (inside <Suspense>, a server action or a route handler).
export async function resolveTenant() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { ok: false, redirect: "/" } as const;

  // The session's active organization is only trusted while the user is still a member of it.
  let tenantId: string | null = null;
  let role = "member";
  const active = session.session.activeOrganizationId;
  if (active) {
    const [m] = await db
      .select({ organizationId: member.organizationId, role: member.role })
      .from(member)
      .where(and(eq(member.userId, session.user.id), eq(member.organizationId, active)));
    tenantId = m?.organizationId ?? null;
    role = m?.role ?? role;
  }
  if (!tenantId) {
    const [m] = await db
      .select({ organizationId: member.organizationId, role: member.role })
      .from(member)
      .where(eq(member.userId, session.user.id))
      .orderBy(asc(member.createdAt))
      .limit(1);
    tenantId = m?.organizationId ?? null;
    role = m?.role ?? role;
  }
  if (!tenantId) return { ok: false, redirect: "/onboarding" } as const;
  return { ok: true, tenantId, role, user: session.user } as const;
}

// Page/server-action version: redirects when there is no restaurant.
export async function requireTenant() {
  const t = await resolveTenant();
  if (!t.ok) redirect(t.redirect);
  return t;
}
