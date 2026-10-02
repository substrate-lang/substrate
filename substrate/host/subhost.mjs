#!/usr/bin/env -S node --stack-size=4000
// Lifecycle: permanent. The host of spec section 4 over Node's V8; bin/sub
// runs the compiler on it. The stack limit, in KiB, is build/subhost's: 4 MiB
// (V8's default is under 1 MiB). The store, the host imports and the
// instantiate hook are host/subhost-core.mjs's, which a browser's host
// shares (host/web); here is what Node gives them: the arguments, files,
// the standard output and error, and the process's end.
//
// host/subhost.mjs DIR [arg ...]: run the program sub build wrote to DIR,
// as build/subhost does.
import fs from 'node:fs';
import crypto from 'node:crypto';
import util from 'node:util';
import { createHost } from './subhost-core.mjs';

const [dir, ...programArgs] = process.argv.slice(2);
if (!dir) {
  process.stderr.write('usage: node host/subhost.mjs DIR [arg ...]\n');
  process.exit(64);
}

// A failed file operation's error, its message the system's, worded as
// C's strerror words it, as build/subhost reports it.
function systemError(e) {
  if (typeof e.errno !== 'number') return e;
  const m = util.getSystemErrorMessage(e.errno);
  return new Error(m.charAt(0).toUpperCase() + m.slice(1));
}

const host = createHost({
  args: programArgs,
  write(fd, bytes) {
    fs.writeSync(fd, bytes);
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
// A program without a main function has nothing to run. A trap in main,
// or an exception that escapes it, is reported as build/subhost reports
// it: what happened, then, for a trap, where; the program's on-trap, if
// it has one, reports it instead (spec 4).
if (typeof entry.main === 'function' &&
    !host.call(entry, entry.main, [], (message) => process.stderr.write(`error: ${message}\n`))) {
  process.exit(2);
}
