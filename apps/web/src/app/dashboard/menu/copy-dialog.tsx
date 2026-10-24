"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup } from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { applyMenuCopy, previewMenuCopy, type CopyPreview } from "./copy-actions";

type Mode = "add" | "update";

// "Copy menu from another of my restaurants": pick a restaurant you also own, see what would happen, then copy. Dishes,
// categories, modifier groups (with their options) and the links between them; matched by name; nothing is deleted.
export function CopyMenuDialog({ open, onClose, sources }: { open: boolean; onClose: () => void; sources: { id: string; name: string }[] }) {
  const [source, setSource] = useState<string | null>(sources.length === 1 ? sources[0].id : null);
  const [mode, setMode] = useState<Mode>("add");
  // The dry run for the CURRENT choice (a result for an older choice is ignored, so there is never a stale preview on screen).
  const [result, setResult] = useState<{ key: string; value: CopyPreview } | null>(null);
  const [pending, startTransition] = useTransition();
  const key = `${source}:${mode}`;
  const preview = result?.key === key ? result.value : null;

  // look before you copy: run the dry run whenever the choice changes
  useEffect(() => {
    if (!open || !source) return;
    let stale = false;
    previewMenuCopy(source, mode).then((value) => { if (!stale) setResult({ key: `${source}:${mode}`, value }); });
    return () => { stale = true; };
  }, [open, source, mode]);

  function copy() {
    if (!source) return;
    startTransition(async () => {
      const r = await applyMenuCopy(source, mode);
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(`Menu copied: ${r.created} dishes added, ${r.updated} updated${r.categories ? `, ${r.categories} categories` : ""}${r.groups ? `, ${r.groups} modifier groups` : ""}`);
      onClose();
    });
  }

  const p = preview?.ok ? preview.plan : null;
  const nothing = !!p && !p.newItems.length && !p.updatedItems.length && !p.newCategories.length && !p.newGroups.length && !p.updatedGroups.length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Copy the menu from another restaurant</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Copies dishes, categories, modifier groups (with their options) and which dish uses what. Dishes are matched by name; nothing
            in this restaurant is deleted. Only restaurants you own are listed.
          </p>
          <div className="flex items-center gap-3">
            <span className="text-sm">Copy from</span>
            <Select
              ariaLabel="Copy from restaurant"
              value={source}
              onChange={setSource}
              width={260}
              placeholder="Choose a restaurant"
              options={sources.map((s) => ({ label: s.name, value: s.id }))}
            />
          </div>
          <RadioGroup
            name="copy-mode"
            ariaLabel="What to copy"
            value={mode}
            onChange={setMode}
            options={[
              { value: "add", label: "Add what is missing here (leave my existing dishes as they are)" },
              { value: "update", label: "Add what is missing and also update dishes I already have (price, names, description, modifiers)" },
            ]}
          />

          {source && !preview && <p className="text-sm text-muted-foreground">Checking…</p>}
          {preview && !preview.ok && <p role="alert" className="text-sm text-destructive-text">{preview.error}</p>}
          {p && (
            <div className="space-y-1 rounded-lg border p-3 text-sm" aria-live="polite">
              <p>
                From <strong>{preview?.ok ? preview.sourceName : ""}</strong>: <strong>{p.newItems.length}</strong> new dishes
                {mode === "update" && <>, <strong>{p.updatedItems.length}</strong> to update</>}, <strong>{p.unchangedItems}</strong> unchanged
              </p>
              {p.newCategories.length > 0 && <p>New categories: {p.newCategories.join(", ")}</p>}
              {p.newGroups.length > 0 && <p>New modifier groups: {p.newGroups.join(", ")}</p>}
              {p.updatedGroups.length > 0 && <p>Modifier groups updated: {p.updatedGroups.join(", ")}</p>}
              {p.ambiguous.length > 0 && <p className="text-warning-text">Skipped (this restaurant has several dishes with that name): {p.ambiguous.join(", ")}</p>}
              {p.newItems.length > 0 && (
                <p className="text-muted-foreground">
                  {p.newItems.slice(0, 8).join(", ")}{p.newItems.length > 8 ? ` and ${p.newItems.length - 8} more` : ""}
                </p>
              )}
              {nothing && <p className="text-muted-foreground">Nothing to copy: this restaurant already has everything.</p>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={pending || !p || nothing} onClick={copy}>Copy menu</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
