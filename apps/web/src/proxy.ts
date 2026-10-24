import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Optimistic gate: signed-out visitors are redirected before anything renders.
// This only checks that a session cookie exists; real authorization (tenant, admin role)
// is still enforced by requireTenant() / requirePlatformAdmin() on the server.
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) return NextResponse.redirect(new URL("/", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/onboarding"],
};
