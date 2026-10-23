// The modules a Node host grants, each loaded when first wanted. A spec names one: NAME; NAME=fake for clock,
// timer, fetch and websocket, with fetch=fake:DIR answering from DIR; net=tls:CERT:KEY.
import fs from 'node:fs';

const granted = (file) => {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new Error(`cannot read ${file}`);
  }
};

const loaders = {
  clock: () => import('../modules/clock.mjs').then((m) => m.clock()),
  random: () => import('../modules/random.mjs').then((m) => m.random()),
  timer: () => import('../modules/timer.mjs').then((m) => m.timer()),
  fetch: () => import('../modules/fetch.mjs').then((m) => m.fetchModule()),
  websocket: () => import('../modules/websocket.mjs').then((m) => m.websocket()),
  worker: () => import('./worker.mjs').then((m) => m.workers()),
  net: () => import('./net.mjs').then((m) => m.netModule()),
  process: () => import('./process.mjs').then((m) => m.processes()),
  stdin: () => import('./stdin.mjs').then((m) => m.stdin()),
  env: () => import('./env.mjs').then((m) => m.env()),
  fs: () => Promise.all([import('../fs.mjs'), import('./fs.mjs')]).then(([core, node]) => core.fsModule(node.nodeFiles())),
  'clock=fake': () => import('./fake.mjs').then((m) => m.fakeClock()),
  'timer=fake': () => import('./fake.mjs').then((m) => m.fakeTimer()),
  'fetch=fake': (root) => import('./fake.mjs').then((m) => m.fakeFetch(root || '.')),
  'websocket=fake': () => import('./fake.mjs').then((m) => m.fakeWebsocket()),
  'net=tls': (cert, key) => import('./net.mjs').then((m) => m.netModule({ tls: { cert: granted(cert), key: granted(key) } })),
};

const parts = (spec) => {
  const [name, how] = spec.split('=');
  const [kind, ...args] = how === undefined ? [] : how.split(':');
  return { name, key: how === undefined ? name : `${name}=${kind}`, args };
};

export const nameOf = (spec) => parts(spec).name;

export function known(spec) {
  const { name, key } = parts(spec);
  return name in loaders && key in loaders;
}

export function loadModule(spec) {
  const { key, args } = parts(spec);
  return loaders[key](...args);
}
