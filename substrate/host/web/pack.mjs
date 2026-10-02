#!/usr/bin/env node
// Lifecycle: experimental. A file pack: files as one, for a page to fetch
// and give a program as its files (host/web/subhost-web.mjs, unpack).
//
//   host/web/pack.mjs -o OUT [-C DIR] PATH ...
//
// Each PATH, a file or a directory with every file in it, is put in OUT
// under its own name, which is relative to DIR, or the working directory:
// its name's length, the name, its length and its bytes, the lengths 32
// bits, little-endian. The files are in the order of their names, so a
// pack's bytes do not depend on a directory's order.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let out = null;
let dir = '.';
const paths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' && i + 1 < args.length) out = args[++i];
  else if (args[i] === '-C' && i + 1 < args.length) dir = args[++i];
  else paths.push(args[i]);
}
if (!out || paths.length === 0) {
  process.stderr.write('usage: host/web/pack.mjs -o OUT [-C DIR] PATH ...\n');
  process.exit(64);
}

const names = [];
function add(name) {
  const full = path.join(dir, name);
  if (fs.statSync(full).isDirectory()) {
    for (const entry of fs.readdirSync(full)) add(path.posix.join(name, entry));
  } else {
    names.push(name);
  }
}
for (const p of paths) add(p.split(path.sep).join('/'));
names.sort();

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const parts = [];
for (const name of names) {
  const bytes = fs.readFileSync(path.join(dir, name));
  const encoded = Buffer.from(name, 'utf8');
  parts.push(u32(encoded.length), encoded, u32(bytes.length), bytes);
}
fs.writeFileSync(out, Buffer.concat(parts));
