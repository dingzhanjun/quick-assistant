"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TimeField } from "@/components/ui/time-field";
import { DAYS, type Day, type OpeningHours } from "@/lib/hours";
import { saveHours } from "./actions";

const LABEL: Record<Day, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

type Row = { open: boolean; from: string; to: string };

export function Hours({ timezone, hours }: { timezone: string; hours: OpeningHours | null }) {
  const [scheduled, setScheduled] = useState(hours !== null);
  const [tz, setTz] = useState(timezone);
  const [rows, setRows] = useState<Record<Day, Row>>(() =>
    Object.fromEntries(
      DAYS.map((d) => {
        const r = hours?.[d]?.[0];
        return [d, { open: !!r, from: r?.[0] ?? "11:00", to: r?.[1] ?? "22:00" }];
      }),
    ) as Record<Day, Row>,
  );
  const [pending, startTransition] = useTransition();

  function save() {
    const value: OpeningHours | null = scheduled
      ? Object.fromEntries(DAYS.filter((d) => rows[d].open).map((d) => [d, [[rows[d].from, rows[d].to]]]))
      : null;
    startTransition(async () => {
      const res = await saveHours(tz, value);
      if (res.ok) toast.success("Opening hours saved");
      else toast.error(res.error);
    });
  }

  const set = (d: Day, patch: Partial<Row>) => setRows((r) => ({ ...r, [d]: { ...r[d], ...patch } }));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Outside these hours the phone agent tells the caller when you are open and hangs up. A closing time
        earlier than the opening time means you close after midnight.
      </p>
      <Checkbox checked={scheduled} onCheckedChange={setScheduled} label="Only answer during opening hours (otherwise the agent answers 24/7)" />
      {scheduled && (
        <>
          <label className="flex items-center gap-2 text-sm">
            Time zone
            <Input value={tz} onChange={(e) => setTz(e.target.value)} className="w-64" placeholder="America/New_York" />
          </label>
          <ul className="space-y-2">
            {DAYS.map((d) => (
              <li key={d} className="flex items-center gap-3 text-sm">
                <div className="w-40">
                  <Checkbox checked={rows[d].open} onCheckedChange={(open) => set(d, { open })} label={LABEL[d]} />
                </div>
                {rows[d].open ? (
                  <>
                    <TimeField value={rows[d].from} onChange={(from) => set(d, { from })} ariaLabel={`${LABEL[d]} opens`} />
                    to
                    <TimeField value={rows[d].to} onChange={(to) => set(d, { to })} ariaLabel={`${LABEL[d]} closes`} />
                  </>
                ) : (
                  <span className="text-muted-foreground">Closed</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <Button onClick={save} disabled={pending}>
        Save hours
      </Button>
    </div>
  );
}
