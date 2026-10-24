"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveAddress, saveHumanLine } from "./actions";

export function Details({ address, humanLine }: { address: string; humanLine: string }) {
  const [line, setLine] = useState(humanLine);
  const [value, setValue] = useState(address);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveAddress(value);
      if (res.ok) toast.success("Address saved");
      else toast.error(res.error);
    });
  }

  function submitLine(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveHumanLine(line);
      if (res.ok) toast.success(line.trim() ? "Human line saved" : "Human line removed");
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-6">
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="address">Address</Label>
        <Input
          id="address"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="123 Main Street, Springfield"
          maxLength={300}
        />
        <p className="text-xs text-muted-foreground">The phone agent tells callers this address if they ask where you are.</p>
      </div>
      <Button type="submit" disabled={pending}>
        Save address
      </Button>
    </form>
    <form onSubmit={submitLine} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="humanLine">Human line</Label>
        <Input
          id="humanLine"
          value={line}
          onChange={(e) => setLine(e.target.value)}
          placeholder="+14155550123"
          inputMode="tel"
        />
        <p className="text-xs text-muted-foreground">
          Callers who press 0 or ask for a person are forwarded to this phone. Leave empty to turn forwarding off.
          It must be a different phone from the agent number above.
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        Save human line
      </Button>
    </form>
    </div>
  );
}
