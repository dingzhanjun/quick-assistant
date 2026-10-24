import { and, eq, gt } from "drizzle-orm";
import { printAgentCommands, printAgents } from "@/db/schema";
import { type TenantTx } from "../tenant-db";

// The ONLY commands a print agent will ever be told to run: a fixed allow-list, never a shell.
export const AGENT_COMMANDS = {
  "restart-agent": "Restart the agent",
  "test-print": "Print a test ticket",
  "show-log": "Show the last log lines",
  "update": "Update the agent software",
  "redetect-printers": "Re-detect printers",
  "reboot": "Reboot the Pi",
  "setup-ticket": "Print the setup ticket (opens the local setup page)",
} as const;
export type AgentCommand = keyof typeof AGENT_COMMANDS;
export const isAgentCommand = (c: string): c is AgentCommand => Object.hasOwn(AGENT_COMMANDS, c);

const MAX_PER_10_MIN = 10;

// Queues a command for an agent (collected through its outbound poll; expires after 5 minutes if not collected).
// Refuses a revoked/unknown agent, a duplicate of one still waiting, and more than 10 per 10 minutes.
export async function queueCommand(
  tx: TenantTx, tenantId: string, agentId: string, command: AgentCommand, requestedBy: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const [agent] = await tx.select({ id: printAgents.id, revokedAt: printAgents.revokedAt })
    .from(printAgents).where(and(eq(printAgents.id, agentId), eq(printAgents.tenantId, tenantId)));
  if (!agent || agent.revokedAt) return { ok: false, error: "Unknown print agent" };
  const since = new Date(Date.now() - 10 * 60_000);
  const recent = await tx.select({ command: printAgentCommands.command, status: printAgentCommands.status })
    .from(printAgentCommands).where(and(eq(printAgentCommands.agentId, agentId), gt(printAgentCommands.createdAt, since)));
  if (recent.some((r) => r.command === command && (r.status === "queued" || r.status === "sent"))) {
    return { ok: false, error: "That command is already waiting for the agent" };
  }
  if (recent.length >= MAX_PER_10_MIN) return { ok: false, error: "Too many commands, wait a few minutes" };
  const [row] = await tx.insert(printAgentCommands).values({ tenantId, agentId, command, requestedBy }).returning({ id: printAgentCommands.id });
  return { ok: true, id: row.id };
}
