// The modules a Node host grants, each loaded when first wanted. A spec names one: NAME; NAME=fake for clock,
// timer, fetch and websocket, with fetch=fake:DIR answering from DIR; net=tls:CERT:KEY.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const read = new Map();
const granted = (file) => {
  if (!read.has(file)) {
    try {
      read.set(file, fs.readFileSync(file));
    } catch (e) {
      throw new Error(`cannot read ${file}`);
    }
  }
  return read.get(file);
};

// The specs whose arguments are files, read when the spec is checked.
const naming = new Set(['net=tls']);

const loaders = {
  clock: () => require('../modules/clock.mjs').clock(),
  random: () => require('../modules/random.mjs').random(),
  timer: () => require('../modules/timer.mjs').timer(),
  fetch: () => require('../modules/fetch.mjs').fetchModule(),
  websocket: () => require('../modules/websocket.mjs').websocket(),
  worker: () => require('./worker.mjs').workers(),
  net: () => require('./net.mjs').netModule(),
  process: () => require('./process.mjs').processes(),
  stdin: () => require('./stdin.mjs').stdin(),
  env: () => require('./env.mjs').env(),
  fs: () => require('../fs.mjs').fsModule(require('./fs.mjs').nodeFiles()),
  'clock=fake': () => require('./fake.mjs').fakeClock(),
  'timer=fake': () => require('./fake.mjs').fakeTimer(),
  'fetch=fake': (root) => require('./fake.mjs').fakeFetch(root || '.'),
  'websocket=fake': () => require('./fake.mjs').fakeWebsocket(),
  'net=tls': (cert, key) => require('./net.mjs').netModule({ tls: { cert: granted(cert), key: granted(key) } }),
};

const parts = (spec) => {
  const [name, how] = spec.split('=');
  const [kind, ...args] = how === undefined ? [] : how.split(':');
  return { name, key: how === undefined ? name : `${name}=${kind}`, args };
};

export const nameOf = (spec) => parts(spec).name;

// Why a program cannot have a module: it could be granted but was not; null for any other.
export const ungranted = (name) => (Object.hasOwn(loaders, name) ? `${name} is not granted (-g ${name})` : null);

// What is wrong with a spec, or null: no such module, or a file it names that cannot be read.
export function problem(spec) {
  const { name, key, args } = parts(spec);
  if (!(name in loaders && key in loaders)) return `no module ${spec}`;
  try {
    if (naming.has(key)) for (const file of args) granted(file);
  } catch (e) {
    return e.message;
  }
  return null;
}

export function loadModule(spec) {
  const { key, args } = parts(spec);
  return loaders[key](...args);
}

// The modules granted by grants, a map from name to spec, each loaded when first wanted; own has some made already.
export function grantedModules(grants, own = new Map()) {
  const loaded = new Map(own);
  return {
    has: (name) => grants.has(name) || loaded.has(name),
    get(name) {
      if (!loaded.has(name)) loaded.set(name, loadModule(grants.get(name)));
      return loaded.get(name);
    },
    keys: () => grants.keys(),
  };
}
