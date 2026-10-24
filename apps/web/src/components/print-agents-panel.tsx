"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { toast } from "@/lib/toast";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/local-time";
import { AGENT_COMMANDS, type AgentCommand } from "@/lib/print/service";

export type AgentView = {
  id: string;
  name: string;
  tenantName?: string; // platform admin view only
  online: boolean;
  revoked: boolean;
  lastSeenAt: string | null;
  pairingOpen: boolean; // a pairing code is still valid
  version: string | null;
  hostname: string | null;
  lanIp: string | null;
  commands: { id: string; command: string; status: string; result: string | null; createdAt: string }[];
};

// Service panel: is the Pi alive, where is it on the network, and the allow-listed commands (never a shell).
// Shared by Settings -> Printing (owner) and /admin/printing (platform admin); `sendCommand` is the matching server action.
export function PrintAgentsPanel({
  agents, sendCommand, extra,
}: {
  agents: AgentView[];
  sendCommand: (agentId: string, command: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  extra?: (a: AgentView) => React.ReactNode; // owner-only buttons (revoke, new code)
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Keep status and command results fresh without a reload.
  useEffect(() => {
    const id = setInterval(() => document.visibilityState === "visible" && router.refresh(), 10_000);
    return () => clearInterval(id);
  }, [router]);

  function send(agentId: string, command: AgentCommand) {
    startTransition(async () => {
      const r = await sendCommand(agentId, command);
      if (r.ok) toast.success("Sent. The agent picks it up within a few seconds.");
      else toast.error(r.error);
    });
  }

  if (!agents.length) return <p className="text-sm text-muted-foreground">No print agent yet.</p>;
  return (
    <div className="space-y-4">
      {agents.map((a) => {
        const state = a.revoked ? "Revoked" : !a.lastSeenAt ? (a.pairingOpen ? "Waiting to pair" : "Pairing code expired") : a.online ? "Online" : "Offline";
        const dot = a.revoked ? "bg-muted-foreground" : a.online ? "bg-green-500" : a.lastSeenAt ? "bg-red-500" : "bg-amber-500";
        return (
          <div key={a.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                <span className={`size-2.5 rounded-full ${dot}`} />
                {a.tenantName ? `${a.tenantName} · ` : ""}{a.name}
                <span className="text-sm font-normal text-muted-foreground">{state}</span>
              </div>
              {extra?.(a)}
            </div>
            {a.lastSeenAt && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <div><dt className="text-muted-foreground">Local IP</dt><dd className="font-mono">{a.lanIp ?? "?"}</dd></div>
                <div><dt className="text-muted-foreground">Host name</dt><dd className="font-mono">{a.hostname ?? "?"}</dd></div>
                <div><dt className="text-muted-foreground">Version</dt><dd>{a.version ?? "?"}</dd></div>
                <div><dt className="text-muted-foreground">Last contact</dt><dd><LocalTime iso={a.lastSeenAt} kind="datetime" /></dd></div>
              </dl>
            )}
            {!a.revoked && a.lastSeenAt && (
              <div className="flex flex-wrap gap-2">
                {(Object.keys(AGENT_COMMANDS) as AgentCommand[]).map((c) =>
                  c === "reboot" ? (
                    <ConfirmButton
                      key={c} variant="outline" disabled={pending || !a.online} destructive={false}
                      title="Reboot the Pi?" description="Printing stops for about a minute. Tickets wait and print afterwards."
                      confirmLabel="Reboot" onConfirm={() => send(a.id, c)}
                    >
                      {AGENT_COMMANDS[c]}
                    </ConfirmButton>
                  ) : (
                    <Button key={c} variant="outline" size="sm" disabled={pending || !a.online} onClick={() => send(a.id, c)}>
                      {AGENT_COMMANDS[c]}
                    </Button>
                  ),
                )}
              </div>
            )}
            {a.commands.length > 0 && (
              <ul className="space-y-2 text-sm">
                {a.commands.map((c) => (
                  <li key={c.id}>
                    <span className="font-mono">{c.command}</span> · {c.status} · <LocalTime iso={c.createdAt} kind="datetime" />
                    {c.result && <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{c.result}</pre>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
