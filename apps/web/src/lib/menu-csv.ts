// Menu import / export as CSV (client-safe: no DB imports; the server plans and applies, the browser exports).
//
// Columns (header names are case-insensitive; the first row must be the header, only `name` and `price` are required):
//   name, description, price (4 or 4.50 or $4.50), available (yes/no/true/false/1/0),
//   categories (several separated by ; or | or ,)
// A column that is not in the file leaves that field untouched on existing dishes. A column that IS in the file
// replaces the field, so an empty description / categories cell clears it.

export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_CHARS = 500_000;

// RFC 4180: quoted fields may contain commas, quotes ("") and line breaks; a leading BOM (Excel) is dropped.
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // blank lines (all cells empty) are ignored
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const ALIASES: Record<string, "name" | "description" | "price" | "available" | "categories"> = {
  name: "name", item: "name", dish: "name", "item name": "name", "dish name": "name",
  description: "description", desc: "description",
  price: "price", "price ($)": "price",
  available: "available", availability: "available",
  category: "categories", categories: "categories",
};
type Field = (typeof ALIASES)[string];

export type ImportRow = {
  line: number; // 1-based line in the file (the header is line 1)
  name: string;
  description?: string;
  priceCents: number;
  available?: boolean; // undefined = not given
  categories?: string[];
};
export type ImportError = { line: number; message: string };
export type ParsedImport = { rows: ImportRow[]; errors: ImportError[]; columns: Field[] };

const TRUE = new Set(["yes", "y", "true", "1", "available", "on"]);
const FALSE = new Set(["no", "n", "false", "0", "unavailable", "sold out", "soldout", "off"]);

export function parsePrice(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents <= 10_000_00 ? cents : null;
}

export function splitCategories(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[;|,]/)) {
    const name = part.trim();
    if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push(name); }
  }
  return out;
}

export function parseMenuCsv(text: string): ParsedImport {
  const errors: ImportError[] = [];
  if (text.length > MAX_IMPORT_CHARS) return { rows: [], errors: [{ line: 1, message: "The file is too large (max about 500 KB)" }], columns: [] };
  const table = parseCsv(text);
  if (!table.length) return { rows: [], errors: [{ line: 1, message: "The file is empty" }], columns: [] };

  const header = table[0].map((h) => ALIASES[h.trim().toLowerCase()] ?? null);
  const unknown = table[0].filter((_, i) => header[i] === null && table[0][i].trim() !== "");
  const col = (f: Field) => header.indexOf(f);
  const columns = [...new Set(header.filter((h): h is Field => h !== null))];
  if (col("name") < 0 || col("price") < 0) {
    return { rows: [], errors: [{ line: 1, message: "The first row must be a header with at least the columns: name, price" }], columns };
  }
  if (unknown.length) errors.push({ line: 1, message: `Unknown column(s): ${unknown.join(", ")}. Allowed: name, description, price, available, categories` });
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    return { rows: [], errors: [{ line: 1, message: `Too many rows (max ${MAX_IMPORT_ROWS} per import)` }], columns };
  }

  const rows: ImportRow[] = [];
  const seen = new Map<string, number>();
  for (const [idx, cells] of table.slice(1).entries()) {
    const line = idx + 2;
    const get = (f: Field) => (col(f) >= 0 ? (cells[col(f)] ?? "").trim() : undefined);
    const name = get("name") ?? "";
    if (!name) { errors.push({ line, message: "Name is missing" }); continue; }
    if (name.length > 200) { errors.push({ line, message: `"${name.slice(0, 30)}…": name is longer than 200 characters` }); continue; }
    const key = name.toLowerCase();
    if (seen.has(key)) { errors.push({ line, message: `"${name}" appears twice (also on line ${seen.get(key)})` }); continue; }
    seen.set(key, line);

    const priceCents = parsePrice(get("price") ?? "");
    if (priceCents === null) { errors.push({ line, message: `"${name}": price must be a number like 4 or 4.50` }); continue; }

    const row: ImportRow = { line, name, priceCents };
    const desc = get("description");
    if (desc !== undefined) { if (desc.length > 1000) { errors.push({ line, message: `"${name}": description is longer than 1000 characters` }); continue; } row.description = desc; }
    const avail = get("available");
    if (avail) {
      const a = avail.toLowerCase();
      if (TRUE.has(a)) row.available = true;
      else if (FALSE.has(a)) row.available = false;
      else { errors.push({ line, message: `"${name}": available must be yes or no` }); continue; }
    }
    const cats = get("categories");
    if (cats !== undefined) {
      row.categories = splitCategories(cats);
      if (row.categories.some((c) => c.length > 100)) { errors.push({ line, message: `"${name}": a category name is longer than 100 characters` }); continue; }
    }
    rows.push(row);
  }
  if (!rows.length && !errors.length) errors.push({ line: 1, message: "There are no dishes in the file" });
  return { rows, errors, columns };
}

const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// The whole menu in the same format the import reads, so "export, edit in Excel, import" round-trips.
export function menuToCsv(items: { name: string; description: string | null; priceCents: number; available: boolean; categories: string[] }[]): string {
  const lines = [["name", "description", "price", "available", "categories"].join(",")];
  for (const i of items) {
    lines.push([i.name, i.description ?? "", (i.priceCents / 100).toFixed(2), i.available ? "yes" : "no", i.categories.join("; ")].map(esc).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`; // BOM so Excel reads the file as UTF-8
}

export const TEMPLATE_CSV = `﻿name,description,price,available,categories\r\nGreen Tea,Hot jasmine tea,4.00,yes,Drinks; Vegetarian\r\nFried Rice,"Egg, peas and carrots",9.50,yes,Main dishes\r\n`;
