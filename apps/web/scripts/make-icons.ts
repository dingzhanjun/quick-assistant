// Regenerates the raster icons from src/app/icon.svg: src/app/favicon.ico (16/32/48) and src/app/apple-icon.png (180); icon.svg is the source.
// Run: pnpm --filter web exec tsx scripts/make-icons.ts   (only needed when icon.svg changes)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const app = path.join(process.cwd(), "src", "app");
const svg = readFileSync(path.join(app, "icon.svg"));

async function png(size: number, opts: { fullBleed?: boolean } = {}) {
  const img = await loadImage(svg);
  const c = createCanvas(size, size);
  const ctx = c.getContext("2d");
  if (opts.fullBleed) {
    // iOS rounds the corners itself: draw the artwork bigger so the rounded SVG corners fall outside the square
    ctx.fillStyle = "#1565d8";
    ctx.fillRect(0, 0, size, size);
    const s = size * 1.0;
    ctx.drawImage(img, (size - s) / 2, (size - s) / 2, s, s);
  } else ctx.drawImage(img, 0, 0, size, size);
  return c.toBuffer("image/png");
}

// ICO container with PNG images (supported everywhere that matters)
function ico(images: { size: number; data: Buffer }[]) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((im, i) => {
    const o = 6 + 16 * i;
    head[o] = im.size; head[o + 1] = im.size; head[o + 2] = 0; head[o + 3] = 0;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(im.data.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += im.data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

(async () => {
  writeFileSync(path.join(app, "favicon.ico"), ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(size) })))));
  writeFileSync(path.join(app, "apple-icon.png"), await png(180, { fullBleed: true }));
  console.log("icons written");
})();
