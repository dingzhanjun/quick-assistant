"use client";

import { useState, useTransition } from "react";
import CheckPicker from "rsuite/CheckPicker";
import { toast } from "@/lib/toast";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { menuToCsv } from "@/lib/menu-csv";
import { deleteMenuItem, saveMenuItem, setAvailability } from "./actions";
import { CopyMenuDialog } from "./copy-dialog";
import { downloadCsv, ImportDialog } from "./import-dialog";

export type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  available: boolean;
  groupIds: string[];
  categoryIds: string[];
};

export type GroupChoice = { id: string; name: string };
export type CategoryChoice = { id: string; name: string };

const ALL = "__all";
const NONE = "__none";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function MenuEditor({ items, groups, categories, canEdit = true, copySources = [] }: { items: MenuItem[]; groups: GroupChoice[]; categories: CategoryChoice[]; canEdit?: boolean; copySources?: { id: string; name: string }[] }) {
  const [editing, setEditing] = useState<MenuItem | "new" | null>(null);
  const [filter, setFilter] = useState<string>(ALL);
  const [importing, setImporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean } & { error?: string }>, success?: string) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Something went wrong");
      else if (success) toast.success(success);
    });
  }

  // One section per category (a dish in several categories appears in each); dishes with none go under "Other".
  const sections = (() => {
    const all = categories.map((c) => ({ key: c.id, title: c.name, items: items.filter((i) => i.categoryIds.includes(c.id)) }));
    const none = { key: NONE, title: categories.length ? "Other" : "Dishes", items: items.filter((i) => i.categoryIds.length === 0) };
    const list = [...all, none].filter((s) => s.items.length);
    return filter === ALL ? list : list.filter((s) => s.key === filter);
  })();

  const renderTable = (rows: MenuItem[]) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Available</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="font-medium">{item.name}</div>
                  {item.description && (
                    <div className="text-sm text-muted-foreground">{item.description}</div>
                  )}
                  {item.categoryIds.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {categories
                        .filter((c) => item.categoryIds.includes(c.id))
                        .map((c) => (
                          <span key={c.id} className="rounded bg-muted px-2 py-0.5 text-xs">
                            {c.name}
                          </span>
                        ))}
                    </div>
                  )}
                  {item.groupIds.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {groups
                        .filter((g) => item.groupIds.includes(g.id))
                        .map((g) => (
                          <span key={g.id} className="rounded-full border px-2 py-0.5 text-xs">
                            {g.name}
                          </span>
                        ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">{money(item.priceCents)}</TableCell>
                <TableCell>
                  <Switch
                    checked={item.available}
                    disabled={pending}
                    onCheckedChange={(v) => run(() => setAvailability(item.id, v))}
                    aria-label={`${item.name} available`}
                  />
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  {canEdit && (
                    <>
                  <Button variant="outline" size="sm" onClick={() => setEditing(item)}>
                    Edit
                  </Button>
                  <ConfirmButton
                    disabled={pending}
                    title={`Delete "${item.name}"?`}
                    description="Past orders keep their copy of the dish."
                    confirmLabel="Delete"
                    onConfirm={() => run(() => deleteMenuItem(item.id), "Item deleted")}
                  >
                    Delete
                  </ConfirmButton>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Menu</h2>
        <div className="flex flex-wrap items-center gap-2">
          {categories.length > 0 && (
            <Select
              ariaLabel="Show category"
              value={filter}
              onChange={setFilter}
              width={200}
              options={[
                { label: "All categories", value: ALL },
                ...categories.map((c) => ({ label: c.name, value: c.id })),
                { label: "Uncategorised", value: NONE },
              ]}
            />
          )}
          {canEdit && (
            <>
              {copySources.length > 0 && <Button variant="outline" onClick={() => setCopying(true)}>Copy from another restaurant</Button>}
              <Button variant="outline" onClick={() => setImporting(true)}>Import CSV</Button>
              <Button variant="outline" disabled={items.length === 0} onClick={() => downloadCsv("menu.csv", menuToCsv(items.map((i) => ({ ...i, categories: categories.filter((c) => i.categoryIds.includes(c.id)).map((c) => c.name) }))))}>
                Export CSV
              </Button>
              <Button onClick={() => setEditing("new")}>Add item</Button>
            </>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          No items yet. Add your first menu item so the phone agent can take orders.
        </p>
      ) : (
        <div className="space-y-6">
          {sections.map((sec) => (
            <section key={sec.key} className="space-y-2">
              {(sections.length > 1 || categories.length > 0) && <h3 className="text-lg font-medium">{sec.title}</h3>}
              {renderTable(sec.items)}
            </section>
          ))}
          {sections.length === 0 && <p className="text-muted-foreground">No dishes in this category.</p>}
        </div>
      )}

      {canEdit && <ImportDialog open={importing} onClose={() => setImporting(false)} />}
      {canEdit && copySources.length > 0 && <CopyMenuDialog key={copying ? "open" : "closed"} open={copying} onClose={() => setCopying(false)} sources={copySources} />}

      <ItemDialog
        // Remount per target so form state resets between items.
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
        item={editing}
        groups={groups}
        categories={categories}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function ItemDialog({
  item,
  groups,
  categories,
  onClose,
}: {
  item: MenuItem | "new" | null;
  groups: GroupChoice[];
  categories: CategoryChoice[];
  onClose: () => void;
}) {
  const existing = item && item !== "new" ? item : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [price, setPrice] = useState(existing ? (existing.priceCents / 100).toFixed(2) : "");
  const [available, setAvailable] = useState(existing?.available ?? true);
  const [groupIds, setGroupIds] = useState<string[]>(existing?.groupIds ?? []);
  const [categoryIds, setCategoryIds] = useState<string[]>(existing?.categoryIds ?? []);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const priceCents = Math.round(Number(price) * 100);
    if (!Number.isFinite(priceCents) || priceCents < 0) return toast.error("Enter a valid price");
    startTransition(async () => {
      const res = await saveMenuItem(existing?.id ?? null, {
        name,
        description,
        priceCents,
        available,
        groupIds,
        categoryIds,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(existing ? "Item updated" : "Item added");
      onClose();
    });
  }

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit item" : "Add item"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ingredients, size, allergens… the voice agent reads this."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="price">Price ($)</Label>
            <Input
              id="price"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="categories">Categories</Label>
            {categories.length === 0 ? (
              <p className="text-sm text-muted-foreground">No categories yet. Create them under the Categories tab.</p>
            ) : (
              <CheckPicker
                id="categories"
                aria-label="Categories"
                block
                searchable={categories.length > 8}
                cleanable
                placeholder="Choose categories"
                data={categories.map((c) => ({ label: c.name, value: c.id }))}
                value={categoryIds}
                onChange={(v) => setCategoryIds(v)}
                menuMaxHeight={240}
              />
            )}
          </div>
          <div className="space-y-2">
            <Label>Modifiers (choices for this dish)</Label>
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No modifier groups yet. Create them under the Modifiers tab.
              </p>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {groups.map((g) => (
                  <Checkbox
                    key={g.id}
                    label={g.name}
                    checked={groupIds.includes(g.id)}
                    onCheckedChange={(on) => setGroupIds((ids) => (on ? [...ids, g.id] : ids.filter((x) => x !== g.id)))}
                  />
                ))}
              </div>
            )}
          </div>
          <Switch id="available" checked={available} onCheckedChange={setAvailable} label="Available" />
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
