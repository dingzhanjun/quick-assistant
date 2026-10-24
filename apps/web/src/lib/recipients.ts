import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { member, user } from "@/db/schema";

export function parseEmails(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);
}

// Who is told about a restaurant's orders: the emails set in Settings, otherwise the restaurant's owners.
export async function recipientsFor(tenantId: string, custom: string | null): Promise<string[]> {
  const list = parseEmails(custom);
  if (list.length) return list;
  const owners = await db
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, tenantId), eq(member.role, "owner")))
    .orderBy(asc(member.createdAt));
  return owners.map((o) => o.email);
}
