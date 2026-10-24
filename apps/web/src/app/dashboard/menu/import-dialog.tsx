"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MAX_IMPORT_CHARS, TEMPLATE_CSV } from "@/lib/menu-csv";
import { toast } from "@/lib/toast";
import { applyMenuImport, previewMenuImport, type ImportPreview } from "./import-actions";

export function downloadCsv(name: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000); // revoking at once cancels the download in some browsers
}

const BADGE: Record<string, string> = {
  create: "border border-current text-success-text",
  update: "border border-current text-warning-text",
  unchanged: "border text-muted-foreground",
};
const LABEL: Record<string, string> = { create: "New", update: "Update", unchanged: "No change" };

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  function reset() {
    setCsv(null); setFileName(""); setPreview(null);
  }
  function close() {
    reset();
    if (input.current) input.current.value = "";
    onClose();
  }

  async function choose(file: File | undefined) {
    reset();
    if (!file) return;
    if (file.size > MAX_IMPORT_CHARS * 2) return toast.error("That file is too large (max about 500 KB)");
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    startTransition(async () => {
      const res = await previewMenuImport(text);
      if (!res.ok) { toast.error(res.error); return; }
      setPreview(res.preview);
    });
  }

  function apply() {
    if (!csv) return;
    startTransition(async () => {
      const res = await applyMenuImport(csv);
      if (!res.ok) { toast.error(res.error); return; }
      toast.success(`Imported: ${res.created} added, ${res.updated} updated${res.newCategories ? `, ${res.newCategories} new categories` : ""}`);
      close();
    });
  }

  const nothingToDo = preview && preview.creates + preview.updates + preview.newCategories.length === 0;
  const canImport = !!preview && preview.errors.length === 0 && !nothingToDo;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Import menu from CSV</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              One dish per row. Columns: <code>name</code>, <code>price</code> (required),{" "}
              <code>description</code>, <code>available</code> (yes/no), <code>categories</code> (separate several with ;).
            </p>
            <p>
              Dishes are matched by name: existing ones are updated, new ones are added, missing categories are created.
              Nothing is deleted, and modifiers are left alone. A column you leave out is not changed; an empty cell in a
              column you include clears that field.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => downloadCsv("menu-template.csv", TEMPLATE_CSV)}>
              Download example file
            </Button>
          </div>

          <div>
            <label htmlFor="menu-csv" className="mb-1 block text-sm font-medium">CSV file</label>
            <input
              id="menu-csv"
              ref={input}
              type="file"
              accept=".csv,text/csv"
              disabled={pending}
              onChange={(e) => choose(e.target.files?.[0])}
              className="block w-full text-sm"
            />
          </div>

          {pending && !preview && <p className="text-sm text-muted-foreground">Checking {fileName}…</p>}

          {preview && (
            <div className="space-y-3" aria-live="polite">
              <p className="text-sm">
                <strong>{preview.creates}</strong> new, <strong>{preview.updates}</strong> to update,{" "}
                <strong>{preview.unchanged}</strong> unchanged
                {preview.newCategories.length > 0 && <> · new categories: <strong>{preview.newCategories.join(", ")}</strong></>}
              </p>

              {preview.errors.length > 0 && (
                <div role="alert" className="rounded-lg border border-destructive p-3 text-sm">
                  <p className="font-medium text-destructive-text">
                    {preview.errors.length} problem{preview.errors.length === 1 ? "" : "s"} to fix in the file, then choose it again:
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {preview.errors.slice(0, 15).map((e, i) => (
                      <li key={i}>Line {e.line}: {e.message}</li>
                    ))}
                  </ul>
                  {preview.errors.length > 15 && <p className="mt-1 text-muted-foreground">…and {preview.errors.length - 15} more</p>}
                </div>
              )}

              {nothingToDo && preview.errors.length === 0 && <p className="text-sm text-muted-foreground">Everything in this file is already on the menu. Nothing to import.</p>}

              {preview.rows.length > 0 && (
                <div className="max-h-72 overflow-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted text-left text-xs uppercase text-muted-foreground">
                      <tr><th className="p-2">Line</th><th className="p-2">Dish</th><th className="p-2">Result</th></tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(0, 200).map((r) => (
                        <tr key={r.line} className="border-t">
                          <td className="p-2 text-muted-foreground">{r.line}</td>
                          <td className="p-2">{r.name}</td>
                          <td className="p-2">
                            <span className={`rounded px-2 py-0.5 text-xs ${BADGE[r.action]}`}>{LABEL[r.action]}</span>
                            {r.changes.length > 0 && <span className="ml-2 text-xs text-muted-foreground">{r.changes.join(", ")}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.rows.length > 200 && <p className="p-2 text-xs text-muted-foreground">Showing the first 200 of {preview.rows.length} dishes.</p>}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>Cancel</Button>
          <Button type="button" disabled={pending || !canImport} onClick={apply}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
