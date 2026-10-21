#!/usr/bin/env node
// Makes the platformer's sprite sheet, ../assets/sprites.png, from the drawing in art.txt.
import fs from 'node:fs';
import zlib from 'node:zlib';

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  process.stderr.write('usage: make-sprites.mjs art.txt sprites.png\n');
  process.exit(64);
}

const size = 16;
const perRow = 8;

const palette = new Map();
const sprites = [];
let section = null;
fs.readFileSync(source, 'utf8').split('\n').forEach((line, index) => {
  const fail = (message) => {
    process.stderr.write(`${source}:${index + 1}: ${message}\n`);
    process.exit(1);
  };
  if (line.startsWith('#') || line.trim() === '') return;
  if (line === 'palette') {
    section = 'palette';
  } else if (line.startsWith('sprite ')) {
    section = 'sprite';
    sprites.push({ name: line.slice(7), rows: [] });
  } else if (section === 'palette') {
    const [character, colour] = line.split(' ');
    if (colour === 'transparent') palette.set(character, [0, 0, 0, 0]);
    else if (/^#[0-9a-f]{6}$/i.test(colour)) {
      palette.set(character, [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16)).concat(255));
    } else fail(`expected a colour like #a0673f, or transparent`);
  } else if (section === 'sprite') {
    const sprite = sprites[sprites.length - 1];
    if (line.length !== size) fail(`a row of ${sprite.name} has ${line.length} characters, not ${size}`);
    for (const character of line) if (!palette.has(character)) fail(`"${character}" is not in the palette`);
    sprite.rows.push(line);
  } else fail('expected "palette" or "sprite NAME"');
});
for (const sprite of sprites) {
  if (sprite.rows.length !== size) {
    process.stderr.write(`${source}: the sprite ${sprite.name} has ${sprite.rows.length} rows, not ${size}\n`);
    process.exit(1);
  }
}

const width = perRow * size;
const height = Math.ceil(sprites.length / perRow) * size;
const pixels = new Uint8Array(width * height * 4);
sprites.forEach((sprite, n) => {
  const left = (n % perRow) * size;
  const top = Math.floor(n / perRow) * size;
  sprite.rows.forEach((row, y) => {
    [...row].forEach((character, x) => {
      pixels.set(palette.get(character), ((top + y) * width + left + x) * 4);
    });
  });
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
process.stdout.write(`${target}: ${sprites.length} sprites, ${width} by ${height} pixels\n`);
