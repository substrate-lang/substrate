#!/usr/bin/env -S node --stack-size=4000
// The host for Node runs the program that `sub build` wrote to DIR, with the grants its flags give (grants.mjs).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createHost, Exit } from './subhost-core.mjs';
import { grantFlag, grantsOf, noGrants } from './grants.mjs';
import { hostFlag, hostModules, setupOf } from './node/modules.mjs';

const require = createRequire(import.meta.url);
const resolveGrant = (p, k) => require('./node/fs.mjs').resolveGrant(p, k);
const resolveFlag = (p, k) => {
  const item = resolveGrant(p, k);
  if (item === null) process.stderr.write(`subhost: --allow-run: ${p} is not found, so it is not granted\n`);
  return item;
};

function usage() {
  process.stderr.write('usage: sub run [FLAG ...] DIR [ARG ...]\n'
    + '  grants: -A, -R[=PATH,...], -W[=PATH,...], -N[=HOST[:PORT],...], -E[=NAME,...], --allow-run[=PROGRAM,...],\n'
    + '          --deny-read=PATH,..., --deny-write=PATH,..., --deny-net=HOST[:PORT],..., --deny-env=NAME,...,\n'
    + '          --deny-run=PROGRAM,...\n'
    + '          a HOST is NAME, *.NAME, ADDRESS or ADDRESS/BITS\n'
    + '  setup: --fake=NAME,... (clock, timer, websocket, fetch:DIR), --tls-cert=FILE --tls-key=FILE\n');
  process.exit(64);
}

function fail(message) {
  process.stderr.write(`subhost: ${message}\n`);
  process.exit(64);
}

const argv = process.argv.slice(2);
const setup = setupOf(noGrants());
while (argv.length > 0 && argv[0].startsWith('-')) {
  const flag = argv.shift();
  try {
    if (!grantFlag(setup.grants, flag, resolveFlag) && !hostFlag(setup, flag)) usage();
  } catch (e) {
    fail(e.message);
  }
}
if (setup.tls && !(setup.tls.cert && setup.tls.key)) fail('--tls-cert and --tls-key go together');
const [dir, ...programArgs] = argv;
if (!dir) usage();

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
  modules: hostModules(setup),
  grants: setup.grants,
  parseGrants: (list) => grantsOf(list, resolveGrant),
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
