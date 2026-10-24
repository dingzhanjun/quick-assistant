"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LocalTime } from "@/components/local-time";
import { TableCell, TableRow } from "@/components/ui/table";
import { addTenantNumber, removeTenantNumber, setTenantSuspended, setTransferNumber } from "./actions";

export type TenantView = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  members: number;
  numbers: string[];
  orders: number;
  suspended: boolean;
  transferNumber: string | null;
};

export function TenantRow({ t }: { t: TenantView }) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const [human, setHuman] = useState(t.transferNumber ?? "");

  function saveHuman(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await setTransferNumber(t.id, human);
      if (!res.ok) return void toast.error(res.error);
      toast.success(human.trim() ? "Human line saved" : "Human line removed");
    });
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await addTenantNumber(t.id, value);
      if (!res.ok) return void toast.error(res.error);
      setValue("");
      toast.success("Number added");
    });
  }
  return (
    <TableRow className={t.suspended ? "opacity-60" : undefined}>
      <TableCell>
        <div className="font-medium">{t.name}</div>
        <div className="text-sm text-muted-foreground">{t.slug}</div>
        <form onSubmit={saveHuman} className="mt-2 flex gap-1" title="Human line: callers pressing 0 or asking for a person are forwarded here (owners can also set it)">
          <Input
            value={human}
            onChange={(e) => setHuman(e.target.value)}
            placeholder="Human line +1415…"
            inputMode="tel"
            aria-label={`Human line for ${t.name}`}
            className="h-7 w-40 text-sm"
          />
          <Button type="submit" size="sm" variant="outline" disabled={pending || human.trim() === (t.transferNumber ?? "")}>
            Save
          </Button>
        </form>
      </TableCell>
      <TableCell>{t.members}</TableCell>
      <TableCell>
        <ul className="space-y-1">
          {t.numbers.map((n) => (
            <li key={n} className="flex items-center gap-2 font-mono text-sm">
              {n}
              <ConfirmButton
                size="icon-xs"
                ariaLabel={`Remove ${n}`}
                disabled={pending}
                title={`Remove ${n} from ${t.name}?`}
                description="Calls to this number stop being answered by the phone agent for this restaurant."
                confirmLabel="Remove number"
                onConfirm={() => startTransition(async () => void (await removeTenantNumber(t.id, n)))}
              >
                ×
              </ConfirmButton>
            </li>
          ))}
        </ul>
        {t.numbers.length === 0 && (
        <form onSubmit={add} className="mt-1 flex gap-1">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="+14155550123"
              inputMode="tel"
              className="h-7 w-36 text-sm"
            />
            <Button type="submit" size="sm" variant="outline" disabled={pending || !value}>
              Add
            </Button>
          </form>
        )}
      </TableCell>
      <TableCell>{t.orders}</TableCell>
      <TableCell>
        <LocalTime iso={t.createdAt} kind="date" />
      </TableCell>
      <TableCell className="text-right">
        {t.suspended ? (
          <Button size="sm" disabled={pending} onClick={() => startTransition(() => setTenantSuspended(t.id, false))}>
            Reactivate
          </Button>
        ) : (
          <ConfirmButton
            variant="outline"
            disabled={pending}
            title={`Suspend ${t.name}?`}
            description="Its phone agent stops answering and taking orders right away (calls get an apology and are hung up)."
            confirmLabel="Suspend"
            onConfirm={() => startTransition(() => setTenantSuspended(t.id, true))}
          >
            Suspend
          </ConfirmButton>
        )}
      </TableCell>
    </TableRow>
  );
}
