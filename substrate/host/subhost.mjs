#!/usr/bin/env -S node --stack-size=4000
// The host for Node runs the program that `sub build` wrote to DIR, with the grants its flags give (grants.mjs).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createHost } from './subhost-core.mjs';
import { joinedGrants, noGrants, pairsFrom, requestOf } from './grants.mjs';
import { hostModules, setupOf, system } from './node/modules.mjs';

const require = createRequire(import.meta.url);
const resolveGrant = (p, k) => require('./node/fs.mjs').resolveGrant(p, k);
const resolveFlag = (p, k) => {
  const item = resolveGrant(p, k);
  if (item === null) process.stderr.write(`substrate: --allow-run: ${p} is not found, so it is not granted\n`);
  return item;
};

function usage() {
  process.stderr.write('usage: subhost.mjs [-A] [--grant KIND ITEM ...] [--] DIR [ARG ...]\n'
    + '  -A grants everything, and --grant grants one KIND and ITEM (grants.sub).\n'
    + '  To run a program yourself, use substrate run.\n');
  process.exit(64);
}

function fail(message) {
  process.stderr.write(`substrate: ${message}\n`);
  process.exit(64);
}

const argv = process.argv.slice(2);
const setup = setupOf(noGrants());
const pairs = [];
while (argv.length > 0 && argv[0].startsWith('-')) {
  const flag = argv.shift();
  if (flag === '--') break;
  if (flag === '-A') for (const k of Object.keys(setup.grants)) setup.grants[k].all = true;
  else if (flag === '--grant' && argv.length >= 2) pairs.push([argv.shift(), argv.shift()]);
  else usage();
}
try {
  const request = requestOf(pairs, resolveFlag);
  if (request.inherit.size > 0) fail('inherit is only for workers');
  setup.grants = joinedGrants(setup.grants, request.grants);
  for (const [name, at] of request.fakes) setup.fakes.set(name, at);
  if (request.tls) {
    const files = [request.tls.cert, request.tls.key];
    setup.tls = { cert: read(files[0]), key: read(files[1]), files };
  }
} catch (e) {
  fail(e.message);
}
const [dir, ...programArgs] = argv;
if (!dir) usage();

function read(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    process.stderr.write(`substrate: cannot read ${file}\n`);
    process.exit(1);
  }
}
const names = read(`${dir}/program`).toString().split(/\r?\n/).filter((n) => n !== '');
const outside = names.find((name) => /[/\\]/.test(name));
if (outside !== undefined) fail(`${dir}/program lists ${outside}, which is not in ${dir}`);
const bytes = new Map(names.map((name) => [name, read(`${dir}/${name}.wasm`)]));
// The compiled modules for sessions: the compiled file lists them, each one is in <hash>.subc, and compiled.map holds
// their module map.
const compiled = new Map();
if (fs.existsSync(`${dir}/compiled`)) {
  const list = read(`${dir}/compiled`);
  const hashes = list.toString().split(/\r?\n/).filter((l) => l !== '').map((l) => l.slice(0, l.indexOf(' ')));
  const bad = hashes.find((h) => !/^[0-9a-f]+$/.test(h));
  if (bad !== undefined) fail(`${dir}/compiled lists ${bad}, which is not a hash`);
  compiled.set('compiled', list);
  if (hashes.length > 0) compiled.set('compiled.map', read(`${dir}/compiled.map`));
  for (const h of hashes) compiled.set(`${h}.subc`, read(`${dir}/${h}.subc`));
}

// The program process.exec_at_end kept (node/process.mjs).
const atEnd = () => {
  const kept = setup.atEnd;
  if (kept) require('./node/process.mjs').become(kept.file, kept.argv, kept.env);
};
process.on('beforeExit', atEnd);

const host = createHost({
  args: programArgs,
  os: system,
  write(fd, bytes) {
    try {
      fs.writeSync(fd, bytes);
    } catch (e) {
      if (e.code === 'EPIPE') process.exit(141);
      throw e;
    }
  },
  report(message) {
    process.stderr.write(`error: ${message}\n`);
  },
  ended(code) {
    if (code === 0) atEnd();
    process.exit(code < 0 ? 2 : code);
  },
  modules: hostModules(setup),
  grants: setup.grants,
  parseGrants: (list) => requestOf(pairsFrom(list), resolveGrant),
  keyOf: (bytes) => crypto.createHash('sha256').update(bytes).digest('hex'),
});

const entry = host.load(names, (name) => bytes.get(name), compiled);
if (!entry) {
  process.stderr.write(`error: ${host.lastError}\n`);
  process.exit(2);
}
if (typeof entry.main === 'function' && !host.call(entry.main, []) && !host.onEvent) {
  process.exit(2);
}
