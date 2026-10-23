#!/usr/bin/env -S node --stack-size=4000
// The host for Node: runs the program that `sub build` wrote to DIR, on V8. A granted module is loaded only
// when the program imports it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createHost, Exit, importedModules } from './subhost-core.mjs';
import { known, loadModule, nameOf } from './node/modules.mjs';

function usage() {
  process.stderr.write('usage: sub run [-g MODULE[=fake[:DIR]|=tls:CERT:KEY],...] DIR [arg ...]\n');
  process.exit(64);
}

const argv = process.argv.slice(2);
const specs = [];
while (argv.length > 0 && argv[0] === '-g') {
  if (argv.length < 2) usage();
  specs.push(...argv[1].split(','));
  argv.splice(0, 2);
}
const [dir, ...programArgs] = argv;
if (!dir) usage();

const grants = new Map();
if (specs.length === 0) for (const name of ['clock', 'random', 'timer', 'worker', 'stdin', 'env', 'fs']) grants.set(name, name);
for (const spec of specs) {
  if (!known(spec)) {
    process.stderr.write(`subhost: no module ${spec}\n`);
    process.exit(64);
  }
  grants.set(nameOf(spec), spec);
}

function read(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    process.stderr.write(`subhost: cannot read ${file}\n`);
    process.exit(1);
  }
}
const names = read(`${dir}/program`).toString().split('\n').filter((n) => n !== '');
const bytes = new Map(names.map((name) => [name, read(`${dir}/${name}.wasm`)]));
const needed = new Set();
for (const b of bytes.values()) for (const name of importedModules(b)) needed.add(name);
const modules = new Map();
for (const [name, spec] of grants) {
  if (!needed.has(name)) continue;
  try {
    modules.set(name, await loadModule(spec));
  } catch (e) {
    process.stderr.write(`subhost: ${e.message}\n`);
    process.exit(64);
  }
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
  exit(code) {
    throw new Exit(code);
  },
  report(message) {
    process.stderr.write(`error: ${message}\n`);
  },
  ended(reason) {
    process.exit(reason.startsWith('exit ') ? Number(reason.slice(5)) : 2);
  },
  modules,
  grants,
  keyOf: (bytes) => crypto.createHash('sha256').update(bytes).digest('hex'),
});

const entry = host.load(names, (name) => bytes.get(name));
if (!entry) {
  process.stderr.write(`error: ${host.lastError}\n`);
  process.exit(2);
}
if (typeof entry.main === 'function' && !host.call(entry.main, []) && typeof entry['on-event'] !== 'function') {
  process.exit(2);
}
