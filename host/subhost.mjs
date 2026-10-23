#!/usr/bin/env -S node --stack-size=4000
// The host for Node: runs the program that `sub build` wrote to DIR, on V8. A granted module is loaded when a
// wasm module importing it is instantiated, which code the program loads at run time may do too.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createHost, Exit } from './subhost-core.mjs';
import { grantedModules, nameOf, problem } from './node/modules.mjs';

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
  const wrong = problem(spec);
  if (wrong) {
    process.stderr.write(`subhost: ${wrong}\n`);
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
const modules = grantedModules(grants);

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
  ended(code) {
    process.exit(code < 0 ? 2 : code);
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
if (typeof entry.main === 'function' && !host.call(entry.main, []) && !host.onEvent) {
  process.exit(2);
}
