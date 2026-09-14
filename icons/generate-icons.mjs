// Generates the extension icons without any image library:
// dark rounded square, blue-to-teal gradient triangle (the "Ads Saver" mark).
// Run: node generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const png = (size, pixelFn) => {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = row + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const lerp = (a, b, t) => a + (b - a) * t;

const draw = (x, y, size) => {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;

  // Rounded-square alpha mask.
  const r = 0.22;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  const d = Math.hypot(u - cx, v - cy);
  const edge = 1.5 / size;
  const alpha = Math.max(0, Math.min(1, (r - d) / edge + 0.5));
  if (alpha <= 0) return [0, 0, 0, 0];

  // Background: near-black navy.
  let R = 16,
    G = 18,
    B = 26;

  // Upward triangle mark, slightly wider than tall.
  const ty = 0.76; // baseline
  const th = 0.52; // height
  const apexY = ty - th;
  if (v <= ty && v >= apexY) {
    const t = (v - apexY) / th; // 0 at apex, 1 at base
    const halfWidth = 0.3 * t + 0.015;
    if (Math.abs(u - 0.5) <= halfWidth) {
      // Vertical gradient: Meta blue up top to teal-green at the base.
      R = Math.round(lerp(45, 49, t));
      G = Math.round(lerp(136, 190, t));
      B = Math.round(lerp(255, 130, t));
    }
  }

  return [R, G, B, Math.round(alpha * 255)];
};

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(here, `icon${size}.png`), png(size, draw));
  console.log(`icon${size}.png`);
}
