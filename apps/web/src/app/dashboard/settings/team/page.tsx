import { and, asc, eq } from "drizzle-orm";
import { Suspense } from "react";
import { invitation, member, user } from "@/db/schema";
import { isOwner } from "@/lib/role-utils";
import { requireTenant } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant-db";
import { Team } from "../team";

async function TeamContent() {
  const { tenantId, role, user: me } = await requireTenant();
  if (!isOwner(role)) {
    return <p className="text-muted-foreground">Only the restaurant owner can change settings.</p>;
  }
  const [team, invites] = await withTenant(tenantId, (db) =>
    Promise.all([
      db
        .select({ id: member.id, userId: member.userId, role: member.role, email: user.email, name: user.name })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.organizationId, tenantId))
        .orderBy(asc(member.createdAt)),
      db
        .select({ id: invitation.id, email: invitation.email, expiresAt: invitation.expiresAt })
        .from(invitation)
        .where(and(eq(invitation.organizationId, tenantId), eq(invitation.status, "pending"))),
    ]),
  );
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Team</h2>
      <Team
        organizationId={tenantId}
        meId={me.id}
        members={team}
        invites={invites.filter((i) => i.expiresAt > new Date()).map((i) => ({ id: i.id, email: i.email }))}
      />
    </section>
  );
}

export default function TeamPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <TeamContent />
    </Suspense>
  );
}
