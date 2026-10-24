import { deflateSync, crc32 } from "node:zlib";

// Minimal encoder for a 1-bit grayscale PNG. `black(x, y)` says which pixels are ink. A thermal ticket is mostly
// white, so the file is a few KB, and the printer agent decodes it with Pillow.
export function encodePng1(width: number, height: number, black: (x: number, y: number) => boolean): Buffer {
  const stride = Math.ceil(width / 8);
  const raw = Buffer.alloc((stride + 1) * height); // each row starts with filter byte 0
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1) + 1;
    for (let x = 0; x < width; x++) if (!black(x, y)) raw[o + (x >> 3)] |= 0x80 >> (x & 7); // 1 = white
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
