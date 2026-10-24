"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { deleteModifierGroup, saveModifierGroup } from "./actions";

export type OptionView = {
  id: string;
  name: string;
  priceDeltaCents: number;
  available: boolean;
};
export type GroupView = {
  id: string;
  name: string;
  required: boolean;
  maxSelect: number;
  itemCount: number;
  options: OptionView[];
};

const money = (cents: number) =>
  `${cents < 0 ? "-" : "+"}$${(Math.abs(cents) / 100).toFixed(2)}`;

export function ModifierEditor({ groups }: { groups: GroupView[] }) {
  const [editing, setEditing] = useState<GroupView | "new" | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-xl font-semibold">Modifiers</h2>
          <p className="text-sm text-muted-foreground">
            Choices for dishes, such as spice level or extras. Create a group once, then attach it to
            any menu items. The phone agent asks the caller about them.
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setEditing("new")}>Add group</Button>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          No modifier groups yet. Try a &ldquo;Spice level&rdquo; group with Not spicy, Mild, Medium
          and Hot.
        </p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={g.id} className="rounded-lg border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium">{g.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {g.required ? "Required" : "Optional"} ·{" "}
                    {g.maxSelect === 1 ? "choose 1" : `choose up to ${g.maxSelect}`} · used by{" "}
                    {g.itemCount} {g.itemCount === 1 ? "item" : "items"}
                  </div>
                </div>
                <div className="space-x-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(g)}>
                    Edit
                  </Button>
                  <ConfirmButton
                    disabled={pending}
                    title={`Delete "${g.name}"?`}
                    description="It will be removed from all menu items."
                    confirmLabel="Delete"
                    onConfirm={() =>
                      startTransition(async () => {
                        await deleteModifierGroup(g.id);
                        toast.success("Group deleted");
                      })
                    }
                  >
                    Delete
                  </ConfirmButton>
                </div>
              </div>
              <ul className="mt-3 flex flex-wrap gap-2 text-sm">
                {g.options.map((o) => (
                  <li
                    key={o.id}
                    className={`rounded-full border px-3 py-1 ${o.available ? "" : "text-muted-foreground line-through"}`}
                  >
                    {o.name}
                    {o.priceDeltaCents !== 0 && ` ${money(o.priceDeltaCents)}`}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <GroupDialog
        // Remount per target so the form state resets between groups.
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
        group={editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

type Row = { key: string; id?: string; name: string; price: string; available: boolean };
let rowCounter = 0;
const newRow = (o?: OptionView): Row => ({
  key: `r${rowCounter++}`,
  id: o?.id,
  name: o?.name ?? "",
  price: o ? (o.priceDeltaCents / 100).toFixed(2) : "0.00",
  available: o?.available ?? true,
});

function GroupDialog({ group, onClose }: { group: GroupView | "new" | null; onClose: () => void }) {
  const existing = group && group !== "new" ? group : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [required, setRequired] = useState(existing?.required ?? false);
  const [maxSelect, setMaxSelect] = useState(String(existing?.maxSelect ?? 1));
  const [rows, setRows] = useState<Row[]>(
    existing?.options.length ? existing.options.map(newRow) : [newRow(), newRow()],
  );
  const [pending, startTransition] = useTransition();

  const update = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const filled = rows.filter((r) => r.name.trim());
    const options = filled.map((r) => ({
      id: r.id,
      name: r.name,
      priceDeltaCents: Math.round(Number(r.price || 0) * 100),
      available: r.available,
    }));
    if (options.some((o) => !Number.isFinite(o.priceDeltaCents))) {
      toast.error("Check the option prices");
      return;
    }
    startTransition(async () => {
      const res = await saveModifierGroup(existing?.id ?? null, {
        name,
        required,
        maxSelect: Number(maxSelect) || 1,
        options,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(existing ? "Group updated" : "Group added");
      onClose();
    });
  }

  return (
    <Dialog open={group !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit group" : "Add group"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="gname">Group name</Label>
            <Input
              id="gname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Spice level"
              required
            />
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <Switch id="required" checked={required} onCheckedChange={setRequired} label="Customer must choose" />
            <div className="flex items-center gap-2">
              <Label htmlFor="max">Choose up to</Label>
              <Input
                id="max"
                type="number"
                min={1}
                max={20}
                className="w-20"
                value={maxSelect}
                onChange={(e) => setMaxSelect(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Options</Label>
            {rows.map((r) => (
              <div key={r.key} className="flex items-center gap-2">
                <Input
                  aria-label="Option name"
                  placeholder="Mild"
                  value={r.name}
                  onChange={(e) => update(r.key, { name: e.target.value })}
                />
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">+$</span>
                  <Input
                    aria-label="Extra price"
                    inputMode="decimal"
                    className="w-[50px]"
                    value={r.price}
                    onChange={(e) => update(r.key, { price: e.target.value })}
                  />
                </div>
                <Switch
                  aria-label="Available"
                  checked={r.available}
                  onCheckedChange={(v) => update(r.key, { available: v })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  aria-label="Remove option"
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, newRow()])}>
              Add option
            </Button>
            <p className="text-xs text-muted-foreground">
              Columns: name, extra price per dish (0 = free), and an on/off switch that hides an option
              without deleting it.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
