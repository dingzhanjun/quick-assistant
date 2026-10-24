import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { phoneNumbers, tenantSettings } from "@/db/schema";
import { phoneCandidates } from "./phone";

// Resolves the dialed number of an agent request to its restaurant, or the error response to return
// (404 unknown number, 403 suspended).
export async function resolveAgentTenant(to: string): Promise<{ tenantId: string } | { response: NextResponse }> {
  const candidates = phoneCandidates(to);
  const [number] = await db
    .select()
    .from(phoneNumbers)
    .where(inArray(phoneNumbers.e164, candidates.length ? candidates : ["-"]));
  if (!number) return { response: NextResponse.json({ error: "unknown number" }, { status: 404 }) };
  const [settings] = await db
    .select({ suspended: tenantSettings.suspended })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, number.tenantId));
  if (settings?.suspended) return { response: NextResponse.json({ error: "suspended" }, { status: 403 }) };
  return { tenantId: number.tenantId };
}
