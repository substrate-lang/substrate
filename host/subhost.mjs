#!/usr/bin/env -S node --stack-size=4000
// The host for Node: runs the program that `sub build` wrote to DIR, on V8.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createHost } from './subhost-core.mjs';
import { clock } from './modules/clock.mjs';
import { random } from './modules/random.mjs';
import { timer } from './modules/timer.mjs';
import { fetchModule } from './modules/fetch.mjs';
import { websocket } from './modules/websocket.mjs';
import { guests } from './node/guest.mjs';
import { netModule } from './node/net.mjs';
import { processes } from './node/process.mjs';
import { stdin } from './node/stdin.mjs';
import { env } from './node/env.mjs';
import { fsModule } from './fs.mjs';
import { nodeFiles } from './node/fs.mjs';
import { fakeClock, fakeTimer, fakeFetch, fakeWebsocket } from './node/fake.mjs';

function usage() {
  process.stderr.write('usage: node host/subhost.mjs [-g MODULE[=fake[:DIR]|=tls:CERT:KEY],...] DIR [arg ...]\n');
  process.exit(64);
}

const argv = process.argv.slice(2);
const grants = [];
while (argv.length > 0 && argv[0] === '-g') {
  if (argv.length < 2) usage();
  grants.push(...argv[1].split(','));
  argv.splice(0, 2);
}
const [dir, ...programArgs] = argv;
if (!dir) usage();

const available = {
  clock: () => clock(),
  random: () => random(),
  timer: () => timer(),
  fetch: () => fetchModule(),
  websocket: () => websocket(),
  guest: () => guests({ cwd: process.cwd() }),
  net: () => netModule(),
  process: () => processes(),
  stdin: () => stdin(),
  env: () => env(),
  fs: () => fsModule(nodeFiles()),
};
const variants = {
  'clock=fake': () => fakeClock(),
  'timer=fake': () => fakeTimer(),
  'fetch=fake': (root) => fakeFetch(root || '.'),
  'websocket=fake': () => fakeWebsocket(),
  'net=tls': (cert, key) => netModule({ tls: { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } }),
};
const modules = new Map();
if (grants.length === 0) for (const name of ['clock', 'random', 'timer', 'guest', 'stdin', 'env', 'fs']) modules.set(name, available[name]());
for (const grant of grants) {
  const [name, how] = grant.split('=');
  const [kind, ...args] = how === undefined ? [] : how.split(':');
  const variant = `${name}=${kind}`;
  if (!(name in available) || (how !== undefined && !(variant in variants))) {
    process.stderr.write(`subhost: no module ${grant}\n`);
    process.exit(64);
  }
  modules.set(name, how === undefined ? available[name]() : variants[variant](...args));
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
    process.exit(code);
  },
  report(message) {
    process.stderr.write(`error: ${message}\n`);
  },
  ended() {
    process.exit(2);
  },
  modules,
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
if (typeof entry.main === 'function' && !host.call(entry.main, []) && typeof entry['on-event'] !== 'function') {
  process.exit(2);
}
