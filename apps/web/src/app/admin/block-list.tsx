"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { blockCaller, unblockCaller } from "./actions";

export function BlockList({ blocked }: { blocked: { e164: string; reason: string | null }[] }) {
  const [number, setNumber] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  function add(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await blockCaller(number, reason);
      if (!res.ok) return void toast.error(res.error);
      setNumber("");
      setReason("");
    });
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Blocked callers</h2>
      <p className="text-sm text-muted-foreground">
        These caller numbers are refused on every restaurant. Callers are also limited to 5 calls per hour.
      </p>
      <ul className="divide-y rounded-lg border">
        {blocked.length === 0 && <li className="p-3 text-sm text-muted-foreground">None.</li>}
        {blocked.map((b) => (
          <li key={b.e164} className="flex items-center justify-between p-3">
            <span>
              <span className="font-mono">{b.e164}</span>
              {b.reason && <span className="ml-2 text-sm text-muted-foreground">{b.reason}</span>}
            </span>
            <ConfirmButton
              disabled={pending}
              destructive={false}
              title={`Unblock ${b.e164}?`}
              description="This caller can phone every restaurant again."
              confirmLabel="Unblock"
              onConfirm={() => startTransition(async () => void (await unblockCaller(b.e164)))}
            >
              Unblock
            </ConfirmButton>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+14155550123" inputMode="tel" required />
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" />
        <Button type="submit" disabled={pending} className="shrink-0">
          Block
        </Button>
      </form>
    </section>
  );
}
