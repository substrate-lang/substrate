#!/usr/bin/env -S node --stack-size=4000
// Lifecycle: permanent.
//
// The host for Node: runs a compiled Substrate program from the command
// line (spec section 4). bin/sub runs the compiler with it.
//
//   host/subhost.mjs DIR [arg ...]
//
// DIR is the program directory that `sub build` wrote. This behaves like
// build/subhost, the C host: same output, same exit statuses.
//
// Loading and linking modules, and the host functions, are in
// host/subhost-core.mjs, which the browser host shares (host/web). This
// file adds what is specific to Node: command-line arguments, real files,
// standard output and error, and exiting the process.
//
// The first line raises V8's stack limit to 4000 KiB (the default is
// under 1 MiB), which matches build/subhost's 4 MiB stack.
import fs from 'node:fs';
import crypto from 'node:crypto';
import util from 'node:util';
import { createHost } from './subhost-core.mjs';

const [dir, ...programArgs] = process.argv.slice(2);
if (!dir) {
  process.stderr.write('usage: node host/subhost.mjs DIR [arg ...]\n');
  process.exit(64);
}

// Converts the error of a failed file operation into an Error whose
// message is the operating system's, worded as C's strerror words it
// ("No such file or directory"), so that messages match build/subhost's.
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
// Run the program's main function, if it has one. A trap in main, or a
// wasm exception that escapes it, is reported as build/subhost reports
// it: the message, then a backtrace for a trap. If the program exports
// on-trap, the program reports the problem itself instead (spec 4). The
// exit status is 2 either way.
if (typeof entry.main === 'function' &&
    !host.call(entry, entry.main, [], (message) => process.stderr.write(`error: ${message}\n`))) {
  process.exit(2);
}
