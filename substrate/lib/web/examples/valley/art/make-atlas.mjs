#!/usr/bin/env node
// Makes the valley's atlas, ../assets/atlas.png: one white tile; the colours are in the vertices.
import fs from 'node:fs';
import zlib from 'node:zlib';

const [target] = process.argv.slice(2);
if (!target) {
  process.stderr.write('usage: make-atlas.mjs atlas.png\n');
  process.exit(64);
}
const size = 16;
const pixels = new Uint8Array(size * size * 4).fill(255);

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
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const rows = Buffer.alloc(size * (1 + size * 4));
for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (1 + size * 4) + 1);
fs.writeFileSync(target, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
]));
process.stdout.write(`${target}: one white tile, ${size} by ${size} pixels\n`);
