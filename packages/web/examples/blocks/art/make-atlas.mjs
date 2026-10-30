#!/usr/bin/env node
// Makes the blocks' texture atlas, ../assets/atlas.png: a row of 16-pixel tiles, one per face kind.
import fs from 'node:fs';
import zlib from 'node:zlib';

const [target] = process.argv.slice(2);
if (!target) {
  process.stderr.write('usage: make-atlas.mjs atlas.png\n');
  process.exit(64);
}

const size = 16;

let seed = 2463534242;
const random = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};
const vary = ([r, g, b], amount) => {
  const d = Math.round((random() * 2 - 1) * amount);
  return [r + d, g + d, b + d].map((c) => Math.max(0, Math.min(255, c)));
};

const grass = [87, 171, 90];
const dirt = [160, 103, 63];
const stone = [138, 146, 156];
const sand = [224, 208, 152];
const wood = [138, 90, 43];
const rings = [176, 124, 68];
const leaves = [58, 140, 60];

// The tiles' places in the atlas are the numbers world.sub uses.
const tiles = [
  (x, y) => vary(grass, 14),
  (x, y) => (y < 3 + (x * 7 % 3) ? vary(grass, 12) : vary(dirt, 10)),
  (x, y) => vary(dirt, 12),
  (x, y) => ((x + y * 3) % 11 === 0 ? vary([108, 116, 126], 6) : vary(stone, 8)),
  (x, y) => vary(sand, 8),
  (x, y) => vary(x % 4 === 0 ? [112, 72, 34] : wood, 8),
  (x, y) => {
    const r = Math.sqrt((x - 7.5) ** 2 + (y - 7.5) ** 2);
    return vary(Math.floor(r) % 3 === 0 ? wood : rings, 6);
  },
  (x, y) => vary((x * 5 + y * 3) % 7 < 2 ? [40, 110, 44] : leaves, 12),
];

const width = tiles.length * size;
const height = size;
const pixels = new Uint8Array(width * height * 4);
tiles.forEach((tile, n) => {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      pixels.set([...tile(x, y), 255], (y * width + n * size + x) * 4);
    }
  }
});

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
};

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8; // 8 bits per channel
header[9] = 6; // colour type 6: red, green, blue and alpha
const rows = Buffer.alloc(height * (1 + width * 4));
for (let y = 0; y < height; y++) {
  rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
}
fs.writeFileSync(target, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(rows)),
  chunk('IEND', Buffer.alloc(0)),
]));
process.stdout.write(`${target}: ${tiles.length} tiles, ${width} by ${height} pixels\n`);
