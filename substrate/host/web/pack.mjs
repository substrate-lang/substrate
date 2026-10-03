#!/usr/bin/env node
// Lifecycle: experimental.
//
// Makes a "file pack": one file that contains many files. A web page can
// then download a whole set of files (for example, library sources) with
// one request, and give them to a program as its files
// (host/web/subhost-web.mjs, `packs` and `unpack`).
//
//   host/web/pack.mjs -o OUT [-C DIR] PATH ...
//
// Each PATH is a file, or a directory, in which case every file inside it
// is included. Paths are relative to DIR if -C is given, otherwise to the
// current directory, and the files are stored under those relative paths.
//
// The format is a sequence of records, one per file:
//   the path's length      32 bits, little-endian
//   the path               UTF-8
//   the content's length   32 bits, little-endian
//   the content
// Files are stored in sorted order of their paths, so the same input
// always produces the same pack.
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
