#!/usr/bin/env -S node --stack-size=4000
// The host for Node: runs the program that `sub build` wrote to DIR, on V8.
import fs from 'node:fs';
import crypto from 'node:crypto';
import util from 'node:util';
import { createHost } from './subhost-core.mjs';

const [dir, ...programArgs] = process.argv.slice(2);
if (!dir) {
  process.stderr.write('usage: node host/subhost.mjs DIR [arg ...]\n');
  process.exit(64);
}

function systemError(e) {
  if (typeof e.errno !== 'number') return e;
  const m = util.getSystemErrorMessage(e.errno);
  return new Error(m.charAt(0).toUpperCase() + m.slice(1));
}

const host = createHost({
  args: programArgs,
  write(fd, bytes) {
    try {
      fs.writeSync(fd, bytes);
    } catch (e) {
      if (e.code === 'EPIPE') process.exit(141);
      throw e;
    }
  },
  readFile(path) {
    try {
      return fs.readFileSync(path);
    } catch (e) {
      throw systemError(e);
    }
  },
  writeFile(path, bytes) {
    try {
      fs.writeFileSync(path, bytes);
    } catch (e) {
      throw systemError(e);
    }
  },
  makeDir(path) {
    try {
      fs.mkdirSync(path, { recursive: true });
    } catch (e) {
      throw systemError(e);
    }
  },
  exit(code) {
    process.exit(code);
  },
  keyOf: (bytes) => crypto.createHash('sha256').update(bytes).digest('hex'),
});

let names;
try {
  names = fs.readFileSync(`${dir}/program`, 'utf8').split('\n').filter((n) => n !== '');
} catch (e) {
  process.stderr.write(`subhost: cannot read ${dir}/program\n`);
  process.exit(1);
}
const entry = host.load(names, (name) => {
  try {
    return fs.readFileSync(`${dir}/${name}.wasm`);
  } catch (e) {
    process.stderr.write(`subhost: cannot read ${dir}/${name}.wasm\n`);
    process.exit(1);
  }
});
if (!entry) {
  process.stderr.write(`error: ${host.lastError}\n`);
  process.exit(2);
}
if (typeof entry.main === 'function' &&
    !host.call(entry, entry.main, [], (message) => process.stderr.write(`error: ${message}\n`))) {
  process.exit(2);
}
