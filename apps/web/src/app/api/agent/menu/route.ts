import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { organization, phoneNumbers, tenantSettings } from "@/db/schema";
import { isAgentRequest } from "@/lib/agent-auth";
import { cachedAgentMenu } from "@/lib/menu-cache";
import { availableMenuWithModifiers } from "@/lib/modifiers";
import { withTenant } from "@/lib/tenant-db";
import { describeHours, isOpenAt } from "@/lib/hours";
import { phoneCandidates } from "@/lib/phone";
import { smsConfigured } from "@/lib/sms";

export async function GET(req: Request) {
  if (!isAgentRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const to = new URL(req.url).searchParams.get("to");
  if (!to) return NextResponse.json({ error: "missing 'to'" }, { status: 400 });

  const [tenant] = await db
    .select({ id: organization.id, name: organization.name })
    .from(phoneNumbers)
    .innerJoin(organization, eq(organization.id, phoneNumbers.tenantId))
    .where(inArray(phoneNumbers.e164, phoneCandidates(to).length ? phoneCandidates(to) : ["-"]));
  if (!tenant) return NextResponse.json({ error: "unknown number" }, { status: 404 });

  const [settings] = await db
    .select({
      suspended: tenantSettings.suspended,
      transferNumber: tenantSettings.transferNumber,
      address: tenantSettings.address,
      timezone: tenantSettings.timezone,
      openingHours: tenantSettings.openingHours,
      textOrderLink: tenantSettings.textOrderLink,
    })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenant.id));
  if (settings?.suspended) return NextResponse.json({ error: "suspended" }, { status: 403 });

  // Closed: the agent says the hours and hangs up (no pre-orders yet).
  const hours = settings?.openingHours ?? null;
  if (hours && !isOpenAt(hours, settings?.timezone ?? "America/New_York")) {
    return NextResponse.json({
      name: tenant.name,
      closed: true,
      hours: describeHours(hours),
      transfer_number: settings?.transferNumber ?? null,
      items: [],
    });
  }

  // Each item carries its modifier groups ("Spice level", "Extras", ...) with their available options.
  return NextResponse.json({
    name: tenant.name,
    transfer_number: settings?.transferNumber ?? null,
    address: settings?.address ?? null,
    // true = after the order the agent offers to text the customer a link to it (provider configured AND the restaurant allows it)
    text_orders: smsConfigured() && (settings?.textOrderLink ?? true),
    items: // Loaded as THIS restaurant inside the database (row-level security).
    await cachedAgentMenu(tenant.id, (id) => withTenant(id, (tx) => availableMenuWithModifiers(id, tx))),
  });
}
