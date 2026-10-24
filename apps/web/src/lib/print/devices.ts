import { and, eq } from "drizzle-orm";
import { printers } from "@/db/schema";
import type { TenantTx } from "../tenant-db";

// Registers the printers an agent reports (USB devices like "lp0"). New ones get an enabled printer row the owner can
// rename and configure; known ones are left alone.
export async function upsertDevices(tx: TenantTx, tenantId: string, agentId: string, devices: { key: string; name?: string }[]) {
  for (const d of devices) {
    const [known] = await tx.select({ id: printers.id }).from(printers).where(and(eq(printers.agentId, agentId), eq(printers.deviceKey, d.key)));
    if (!known) await tx.insert(printers).values({ tenantId, agentId, deviceKey: d.key, name: d.name || (d.key === "lp0" ? "Kitchen" : d.key) });
  }
}
