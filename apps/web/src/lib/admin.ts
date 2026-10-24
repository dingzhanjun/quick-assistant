import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth, platformAdminEmails } from "./auth";

// Guard for /admin. Returns 404 (not 403) so the area isn't discoverable.
// Call only in request scope (inside <Suspense> or a server action).
export async function requirePlatformAdmin() {
  const session = await auth.api.getSession({ headers: await headers() });
  const u = session?.user;
  const ok =
    !!u &&
    u.emailVerified &&
    (u.role === "admin" || platformAdminEmails.includes(u.email.toLowerCase()));
  if (!ok) notFound();
  return session.user;
}
