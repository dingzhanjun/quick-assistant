"use client";

import { useState, useTransition } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/toast";
import { deleteCategory, moveCategory, saveCategory } from "./actions";

export type CategoryView = { id: string; name: string; itemCount: number };

export function CategoryEditor({ categories }: { categories: CategoryView[] }) {
  const [editing, setEditing] = useState<CategoryView | "new" | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean } & { error?: string }>, success?: string) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Something went wrong");
      else if (success) toast.success(success);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-xl font-semibold">Categories</h2>
          <p className="text-sm text-muted-foreground">
            Group dishes such as Drinks, Appetizers or Vegetarian. A dish can be in several categories: tick them
            on the dish in the Menu tab. The phone agent uses them to answer &ldquo;what drinks do you have?&rdquo;
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setEditing("new")}>Add category</Button>
      </div>

      {categories.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          No categories yet. Try &ldquo;Drinks&rdquo;, &ldquo;Appetizers&rdquo; and &ldquo;Main dishes&rdquo;.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {categories.map((c, i) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1 basis-48">
                <div className="font-medium">{c.name}</div>
                <div className="text-sm text-muted-foreground">
                  {c.itemCount} {c.itemCount === 1 ? "dish" : "dishes"}
                </div>
              </div>
              <Button variant="outline" size="sm" disabled={pending || i === 0} aria-label={`Move ${c.name} up`} onClick={() => run(() => moveCategory(c.id, "up"))}>
                ↑
              </Button>
              <Button variant="outline" size="sm" disabled={pending || i === categories.length - 1} aria-label={`Move ${c.name} down`} onClick={() => run(() => moveCategory(c.id, "down"))}>
                ↓
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(c)}>Edit</Button>
              <ConfirmButton
                disabled={pending}
                title={`Delete "${c.name}"?`}
                description="The dishes stay on the menu; they just leave this category."
                confirmLabel="Delete"
                onConfirm={() => run(() => deleteCategory(c.id), "Category deleted")}
              >
                Delete
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}

      <CategoryDialog key={editing === null ? "closed" : editing === "new" ? "new" : editing.id} target={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function CategoryDialog({ target, onClose }: { target: CategoryView | "new" | null; onClose: () => void }) {
  const existing = target && target !== "new" ? target : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveCategory(existing?.id ?? null, { name });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(existing ? "Category updated" : "Category added");
      onClose();
    });
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit category" : "Add category"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cat-name">Name</Label>
            <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
