import path from "node:path";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { encodePng1 } from "./png1";
import type { Ticket } from "./ticket";

// Renders a ticket as a 1-bit PNG, `widthDots` wide (576 = 80 mm paper, 384 = 58 mm). Drawing everything as a picture
// means tickets print on any ESC/POS printer, the layout is identical everywhere, and a layout change never needs an
// agent update. Font: Roboto (SIL OFL), shipped in assets/fonts.
export const PAPER_DOTS = { 80: 576, 58: 384 } as const;
export const dotsForMm = (mm: number) => (mm <= 58 ? PAPER_DOTS[58] : PAPER_DOTS[80]);

const FONT = "OrderTicketSans";
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  const dir = path.join(process.cwd(), "assets", "fonts");
  GlobalFonts.registerFromPath(path.join(dir, "Roboto-Regular.ttf"), FONT);
  GlobalFonts.registerFromPath(path.join(dir, "Roboto-Bold.ttf"), `${FONT} Bold`);
  fontsReady = true;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const TOKENS = /\S+|\s+/g;

// Greedy wrap: breaks at spaces; a single over-long word is split by characters.
function wrap(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const fits = (s: string) => ctx.measureText(s).width <= maxWidth;
  const lines: string[] = [];
  let cur = "";
  const push = (word: string) => {
    if (fits(word)) { cur = word; return; }
    cur = "";
    for (const ch of word) {
      if (cur && !fits(cur + ch)) { lines.push(cur); cur = ch; } else cur += ch;
    }
  };
  for (const tok of text.match(TOKENS) ?? []) {
    if (/^\s+$/.test(tok)) { if (cur) cur += tok; continue; }
    if (!cur || fits((cur + tok).trimEnd())) { if (cur) cur += tok; else push(tok); }
    else { lines.push(cur.trimEnd()); push(tok); }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

export function renderTicketPng(ticket: Ticket, widthDots: number = PAPER_DOTS[80]): Buffer {
  ensureFonts();
  const W = widthDots;
  const M = 12; // side margin
  const MAX_H = 6000;
  const canvas = createCanvas(W, MAX_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, MAX_H);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  let y = 8;

  const font = (px: number, bold = false) => { ctx.font = `${px}px "${bold ? `${FONT} Bold` : FONT}"`; };
  const text = (s: string, px: number, o: { bold?: boolean; align?: "left" | "center"; indent?: number; gap?: number; reserve?: number } = {}) => {
    font(px, o.bold);
    const indent = o.indent ?? 0;
    for (const line of wrap(ctx, s, W - 2 * M - indent - (o.reserve ?? 0))) {
      ctx.textAlign = o.align === "center" ? "center" : "left";
      ctx.fillText(line, o.align === "center" ? W / 2 : M + indent, y);
      y += Math.round(px * 1.3);
    }
    y += o.gap ?? 0;
  };
  const rule = (dashed = false) => {
    ctx.fillRect(M, y + 4, W - 2 * M, 3);
    if (dashed) { ctx.fillStyle = "#fff"; for (let x = M + 6; x < W - M; x += 16) ctx.fillRect(x, y + 3, 8, 5); ctx.fillStyle = "#000"; }
    y += 14;
  };

  // Banner: CANCELLED is white-on-black so it cannot be missed.
  const banner =
    ticket.kind === "cancelled" ? "CANCELLED"
    : ticket.kind === "changed" ? `CHANGED${ticket.replaces ? ` (replaces #${ticket.replaces})` : ""}`
    : ticket.kind === "reprint" ? "REPRINT"
    : ticket.kind === "test" ? "TEST" : "";
  if (banner) {
    const inverted = ticket.kind === "cancelled";
    if (inverted) { ctx.fillRect(0, y - 2, W, 54); ctx.fillStyle = "#fff"; }
    font(banner.length > 14 ? 28 : 38, true);
    ctx.textAlign = "center";
    ctx.fillText(banner, W / 2, y + 4, W - 2 * M);
    ctx.fillStyle = "#000";
    y += 60;
  }

  text(ticket.restaurant, 28, { bold: true, align: "center", gap: 4 });
  if (ticket.orderNumber != null) text(`#${ticket.orderNumber}`, 96, { bold: true, align: "center" });
  text(`Pickup: ${ticket.pickup}`, W < 500 ? 40 : 52, { bold: true, align: "center", gap: 4 });
  if (ticket.customerName) text(`Guest: ${ticket.customerName}`, 34, { align: "center" });
  text(`Placed: ${ticket.placedAt}`, 22, { align: "center", gap: 2 });
  rule();

  for (const line of ticket.lines) {
    const label = `${line.quantity} x ${line.name}`;
    if (line.lineCents == null) text(label, 34, { bold: true });
    else {
      // Price at the right edge of the item's first row; the name wraps in the space left of it.
      const price = money(line.lineCents);
      font(30, true);
      const pw = Math.ceil(ctx.measureText(price).width);
      const top = y;
      text(label, 34, { bold: true, reserve: pw + 12 });
      font(30, true);
      ctx.textAlign = "right";
      ctx.fillText(price, W - M, top + 2);
      ctx.textAlign = "left";
    }
    for (const o of line.options) text(`+ ${o}`, 26, { indent: 36 });
    if (line.notes) text(`NOTE: ${line.notes}`, 26, { indent: 36, bold: true });
    y += 8;
    rule(true);
  }
  // Total at the left and the item count at the right of the same row.
  const count = ticket.lines.reduce((n, l) => n + l.quantity, 0);
  if (ticket.totalCents > 0 || ticket.lines.length) {
    const top = y;
    if (ticket.totalCents > 0) text(`Total: ${money(ticket.totalCents)}`, 34, { bold: true, reserve: 150 });
    else y += Math.round(34 * 1.3);
    if (ticket.lines.length) {
      font(28, true);
      ctx.textAlign = "right";
      ctx.fillText(`Items: ${count}`, W - M, top + 4);
      ctx.textAlign = "left";
    }
    y += 4;
  }
  y += 24; // feed margin before the cut

  const height = Math.min(y, MAX_H);
  const data = ctx.getImageData(0, 0, W, height).data;
  return encodePng1(W, height, (x, yy) => data[(yy * W + x) * 4] < 140);
}
