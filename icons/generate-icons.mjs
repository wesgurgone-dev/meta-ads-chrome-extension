// Generates the extension icons without any image library: a stack of three
// cards, receding to the left, on a transparent background - a swipe file.
//
// The reference for this mark was white cards on black. On a transparent
// background a white front card disappears against a light Chrome toolbar, so
// the stack is drawn in the brand blue instead: the front card solid, the two
// behind it progressively more transparent. Same silhouette, legible on any
// backdrop.
//
// Run: node generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// --- PNG encoding ---------------------------------------------------------

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

// --- The mark -------------------------------------------------------------

// The brand ramp, on the front card only. The two behind it are flat lilac, so
// the gradient reads as the face of the stack rather than as three shapes that
// happen to share a wash.
const RAMP = [
  [69, 16, 232], // #4510e8
  [237, 12, 221], // #ed0cdd
  [255, 196, 29], // #ffc41d
];
const LILAC = [155, 140, 242]; // #9b8cf2

// Back to front. Coordinates are fractions of the canvas.
const CARDS = [
  { x0: 0.08, y0: 0.3, x1: 0.44, y1: 0.7, r: 0.05, alpha: 0.5, flat: LILAC },
  { x0: 0.26, y0: 0.22, x1: 0.66, y1: 0.78, r: 0.055, alpha: 0.8, flat: LILAC },
  { x0: 0.46, y0: 0.12, x1: 0.92, y1: 0.88, r: 0.07, alpha: 1 },
];

/** Signed distance to a rounded rectangle; negative inside. */
const roundedRectSDF = (px, py, card) => {
  const cx = (card.x0 + card.x1) / 2;
  const cy = (card.y0 + card.y1) / 2;
  const hx = (card.x1 - card.x0) / 2 - card.r;
  const hy = (card.y1 - card.y0) / 2 - card.r;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - card.r;
};

/** Ramp colour at a point, sampled across the top-left/bottom-right axis. */
const gradientAt = (u, v) => {
  const t = Math.min(Math.max((u + v) / 2, 0), 1);
  const span = 1 / (RAMP.length - 1);
  const i = Math.min(Math.floor(t / span), RAMP.length - 2);
  const k = (t - i * span) / span;
  return [0, 1, 2].map((c) => RAMP[i][c] + (RAMP[i + 1][c] - RAMP[i][c]) * k);
};

const draw = (x, y, size) => {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;
  const edge = 1 / size; // one pixel, for anti-aliasing

  // Composite back to front, source-over, over a transparent canvas.
  let R = 0;
  let G = 0;
  let B = 0;
  let A = 0;

  // The ramp spans the whole mark, so the front card reads as one lit face
  // rather than a gradient restarting inside its own bounds.
  const [gr, gg, gb] = gradientAt(u, v);

  for (const card of CARDS) {
    const d = roundedRectSDF(u, v, card);
    const coverage = Math.min(Math.max(0.5 - d / edge, 0), 1);
    if (coverage <= 0) continue;
    const [cr, cg, cb] = card.flat || [gr, gg, gb];
    const sa = coverage * card.alpha;
    const outA = sa + A * (1 - sa);
    if (outA <= 0) continue;
    R = (cr * sa + R * A * (1 - sa)) / outA;
    G = (cg * sa + G * A * (1 - sa)) / outA;
    B = (cb * sa + B * A * (1 - sa)) / outA;
    A = outA;
  }

  return [Math.round(R), Math.round(G), Math.round(B), Math.round(A * 255)];
};

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(here, `icon${size}.png`), png(size, draw));
  console.log(`icon${size}.png`);
}
