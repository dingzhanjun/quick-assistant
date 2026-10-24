import type { AgentView } from "@/components/print-agents-panel";
import { isOnline } from "./agent";

type AgentRow = {
  id: string; name: string; version: string | null; hostname: string | null; lanIp: string | null;
  lastSeenAt: Date | null; revokedAt: Date | null; pairingExpiresAt: Date | null;
};
type CommandRow = { id: string; agentId: string; command: string; status: string; result: string | null; createdAt: Date };

// Rows -> what the service panel shows (online = heard from in the last 90 s). Plain function, called from server pages.
export function agentViews(agents: (AgentRow & { tenantName?: string })[], commands: CommandRow[], perAgent = 4): AgentView[] {
  const now = Date.now();
  return agents.map((a) => ({
    id: a.id, name: a.name, tenantName: a.tenantName, online: isOnline(a.lastSeenAt, now), revoked: !!a.revokedAt,
    lastSeenAt: a.lastSeenAt?.toISOString() ?? null, pairingOpen: !!a.pairingExpiresAt && a.pairingExpiresAt.getTime() > now,
    version: a.version, hostname: a.hostname, lanIp: a.lanIp,
    commands: commands.filter((c) => c.agentId === a.id).slice(0, perAgent)
      .map((c) => ({ id: c.id, command: c.command, status: c.status, result: c.result, createdAt: c.createdAt.toISOString() })),
  }));
}
