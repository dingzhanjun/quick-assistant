"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { ConfirmButton } from "@/components/confirm-button";
import { PrintAgentsPanel, type AgentView } from "@/components/print-agents-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Disclosure } from "@/components/ui/disclosure";
import { RadioGroup } from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";
import type { PrinterStatus } from "@/db/schema";
import { createPrintAgent, createSetupFiles, deletePrintAgent, newPairingCodeFor, removePrinter, revokePrintAgent, savePrintSettings, sendAgentCommand, testPrint, updatePrinter } from "./print-actions";

export type PrinterView = {
  id: string; name: string; agentName: string | null; paperWidthMm: number; copies: number; enabled: boolean;
  status: PrinterStatus | null; agentOnline: boolean;
};


function statusText(p: PrinterView): { text: string; ok: boolean } {
  if (!p.agentOnline) return { text: "Agent offline", ok: false };
  const s = p.status;
  if (!s) return { text: "Waiting for status", ok: true };
  if (s.paperOut) return { text: "Out of paper", ok: false };
  if (s.coverOpen) return { text: "Cover open", ok: false };
  if (s.online === false) return { text: s.error ?? "Printer not responding", ok: false };
  return { text: "Ready", ok: true };
}

function PrinterRow({ p }: { p: PrinterView }) {
  const [name, setName] = useState(p.name);
  const [width, setWidth] = useState(p.paperWidthMm);
  const [copies, setCopies] = useState(p.copies);
  const [enabled, setEnabled] = useState(p.enabled);
  const [pending, startTransition] = useTransition();
  const st = statusText(p);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, ok: string) =>
    startTransition(async () => { const r = await fn(); if (r.ok) toast.success(ok); else toast.error(r.error); });
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
      <div className="space-y-1"><Label>Name</Label><Input className="w-40" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="space-y-1">
        <Label>Paper</Label>
        <Select ariaLabel="Paper width" value={width} onChange={setWidth} width={100} options={[{ label: "80 mm", value: 80 }, { label: "58 mm", value: 58 }]} />
      </div>
      <div className="space-y-1">
        <Label>Copies</Label>
        <Select ariaLabel="Copies" value={copies} onChange={setCopies} width={80} options={[1, 2, 3].map((n) => ({ label: String(n), value: n }))} />
      </div>
      <div className="pb-1"><Switch checked={enabled} onCheckedChange={setEnabled} label="On" /></div>
      <div className="pb-1 text-sm">
        <span className={st.ok ? "text-success-text" : "text-destructive-text"}>{st.text}</span>
        {p.agentName && <span className="text-muted-foreground"> · {p.agentName}</span>}
      </div>
      <div className="ml-auto flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(() => updatePrinter(p.id, { name, paperWidthMm: width as 58 | 80, copies, enabled }), "Printer saved")}>Save</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => testPrint(p.id), "Test ticket queued")}>Test print</Button>
        <ConfirmButton disabled={pending} title={`Remove printer "${p.name}"?`} description="Tickets stop printing on it. You can add it again by re-detecting printers." confirmLabel="Remove" onConfirm={() => run(() => removePrinter(p.id), "Printer removed")}>Remove</ConfirmButton>
      </div>
    </div>
  );
}

function download(name: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }) /* text/plain makes browsers add ".txt", and cloud-init needs the exact name */);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000); // revoking at once cancels the download in some browsers
}

// Monitor-less setup: generates the files to copy onto the SD card's boot partition (see lib/print/firstboot.ts).
function SetupFiles({ enabled }: { enabled: boolean }) {
  const [f, setF] = useState({ name: "", hostname: "kitchen-pi", ssid: "", wifiPassword: "", country: "US", sshKey: "" });
  const [done, setDone] = useState<{ files: { name: string; content: string }[]; days: number } | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Disclosure summary="Set up a new Pi without a monitor (SD card files)">
      {!enabled ? (
        <p className="mt-3 text-sm text-muted-foreground">Not available on this server: it does not carry the print-agent files (they are built into the production web image).</p>
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const r = await createSetupFiles({ name: f.name.trim() || "Kitchen", hostname: f.hostname, ssid: f.ssid || undefined, wifiPassword: f.wifiPassword, country: f.country, sshKey: f.sshKey || undefined });
              if (!r.ok) {
                toast.error(r.error);
                return;
              }
              // No automatic download: browsers block a second automatic download from one click (the user then sees only
              // one of the two files). Each file gets its own button below instead; the contents are kept in memory only.
              setF({ ...f, wifiPassword: "" });
              setDone({ files: r.files, days: r.days });
            });
          }}
        >
          <p className="text-sm text-muted-foreground">
            1. Flash <b>Raspberry Pi OS Lite (Trixie)</b> with Raspberry Pi Imager, without its own customisation. 2. Download the files here and copy them onto the
            card&apos;s boot drive (<code>bootfs</code>), replacing the ones there. 3. Put the card in the Pi, connect the printer and power. It installs and pairs itself.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="sf-name">Agent name</Label><Input id="sf-name" value={f.name} onChange={set("name")} placeholder="Kitchen" /></div>
            <div className="space-y-1"><Label htmlFor="sf-host">Pi host name</Label><Input id="sf-host" value={f.hostname} onChange={set("hostname")} /></div>
            <div className="space-y-1"><Label htmlFor="sf-ssid">Wi-Fi name (leave empty for a network cable)</Label><Input id="sf-ssid" value={f.ssid} onChange={set("ssid")} autoComplete="off" /></div>
            <div className="space-y-1"><Label htmlFor="sf-wpw">Wi-Fi password</Label><Input id="sf-wpw" type="password" value={f.wifiPassword} onChange={set("wifiPassword")} autoComplete="off" disabled={!f.ssid} /></div>
            <div className="space-y-1"><Label htmlFor="sf-country">Wi-Fi country (2 letters)</Label><Input id="sf-country" value={f.country} onChange={set("country")} maxLength={2} disabled={!f.ssid} /></div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sf-key">Optional: SSH public key for an engineer</Label>
            <Input id="sf-key" value={f.sshKey} onChange={set("sshKey")} placeholder="ssh-ed25519 AAAA..." autoComplete="off" />
            <p className="text-xs text-muted-foreground">Without a key nobody can log in to the Pi; you manage it from this page.</p>
          </div>
          <Button type="submit" variant="outline" disabled={pending}>Create setup files</Button>
          {done && (
            <div className="space-y-3 rounded bg-muted p-3 text-sm">
              <p>
                Your setup files are ready. <b>Download each one</b>{done.files.length > 1 ? " (there are two)" : ""} and copy {done.files.length > 1 ? "them" : "it"} onto the card&apos;s boot drive,
                replacing the existing file{done.files.length > 1 ? "s" : ""}. The names must be exactly as shown, with no .txt at the end.
              </p>
              <div className="flex flex-wrap gap-2">
                {done.files.map((x) => (
                  <Button key={x.name} type="button" size="sm" onClick={() => download(x.name, x.content)}>
                    Download {x.name}
                  </Button>
                ))}
              </div>
              <p>
                The files hold a one-time pairing code that works for {done.days} days: keep them private and boot the Pi within that time. After about 5 minutes the agent
                appears below as Online and the printer prints a short test ticket.
              </p>
            </div>
          )}
        </form>
      )}
    </Disclosure>
  );
}

export function Printing(props: {
  timing: "immediate" | "on_accept"; agents: AgentView[]; printers: PrinterView[]; serverUrl: string; installBase: string;
}) {
  const [timing, setTiming] = useState(props.timing);
  const [agentName, setAgentName] = useState("");
  const [pairing, setPairing] = useState<{ code: string; minutes: number } | null>(null);
  const [pending, startTransition] = useTransition();

  const pair = (fn: () => ReturnType<typeof createPrintAgent>) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) { setPairing({ code: r.code, minutes: r.minutes }); setAgentName(""); } else toast.error(r.error);
    });

  return (
    <div className="space-y-8">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const r = await savePrintSettings(timing);
            if (r.ok) toast.success("Printing settings saved"); else toast.error(r.error);
          });
        }}
      >
        <div className="space-y-2">
          <Label>When to print a new phone order</Label>
          <RadioGroup
            name="print-timing"
            ariaLabel="When to print a new phone order"
            value={timing}
            onChange={setTiming}
            options={[
              { value: "immediate", label: "Immediately, as soon as the order is taken" },
              { value: "on_accept", label: "Only after the restaurant confirms it: press Confirm & Print on the order card" },
            ]}
          />
        </div>
        <Button type="submit" disabled={pending}>Save printing settings</Button>
      </form>

      <div className="space-y-3">
        <h3 className="font-medium">Printers</h3>
        {props.printers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No printer yet. Add a print agent below, plug the printer into it by USB, and it appears here.</p>
        ) : props.printers.map((p) => <PrinterRow key={p.id} p={p} />)}
      </div>

      <div className="space-y-3">
        <h3 className="font-medium">Print agents (the small computer next to the printer)</h3>
        <PrintAgentsPanel
          agents={props.agents}
          sendCommand={sendAgentCommand}
          extra={(a) => (
            <div className="flex gap-2">
              {!a.revoked && !a.lastSeenAt && <Button size="sm" variant="outline" disabled={pending} onClick={() => pair(() => newPairingCodeFor(a.id))}>New pairing code</Button>}
              {!a.revoked && (
                <ConfirmButton disabled={pending} title={`Revoke "${a.name}"?`} description="It stops printing immediately and has to be paired again with a new code." confirmLabel="Revoke" onConfirm={() => startTransition(async () => {
                  const r = await revokePrintAgent(a.id); if (r.ok) toast.success("Revoked"); else toast.error(r.error);
                })}>Revoke</ConfirmButton>
              )}
              {/* finished with: revoked, or never paired. Deleting also removes its printers and their ticket history. */}
              {(a.revoked || !a.lastSeenAt) && (
                <ConfirmButton disabled={pending} title={`Delete "${a.name}"?`} description="The agent, its printers and their ticket history are removed. Tickets still waiting for it are dropped." confirmLabel="Delete" onConfirm={() => startTransition(async () => {
                  const r = await deletePrintAgent(a.id); if (r.ok) toast.success("Deleted"); else toast.error(r.error);
                })}>Delete</ConfirmButton>
              )}
            </div>
          )}
        />
        <SetupFiles enabled={!!props.installBase} />
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); pair(() => createPrintAgent(agentName)); }}>
          <div className="space-y-1"><Label htmlFor="agent-name">Add a print agent</Label><Input id="agent-name" className="w-48" placeholder="Kitchen" value={agentName} onChange={(e) => setAgentName(e.target.value)} /></div>
          <Button type="submit" variant="outline" disabled={pending}>Get pairing code</Button>
        </form>
        {pairing && (
          <div className="space-y-2 rounded-lg border border-primary p-4">
            <p className="text-sm">Pairing code (shown once, valid {pairing.minutes} minutes):</p>
            <p className="font-mono text-2xl font-semibold tracking-widest">{pairing.code}</p>
            <p className="text-sm text-muted-foreground">{props.installBase ? "On a new Pi (Raspberry Pi OS), run this once:" : "On the Pi, where the agent is installed, run:"}</p>
            <pre className="overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
              {props.installBase
                ? `curl -fsSL ${props.serverUrl}/install-printer.sh | sudo sh -s -- ${pairing.code} --server ${props.serverUrl} --base ${props.installBase}`
                : `order-printer pair ${pairing.code} --server ${props.serverUrl}`}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
