// The host modules of a program on Node, each made when first needed, with the program's grants and the fakes
// and certificate the host was set up with.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { listOf } from '../grants.mjs';

const require = createRequire(import.meta.url);

const loaders = {
  clock: (s) => (s.fakes.has('clock') ? require('./fake.mjs').fakeClock() : require('../modules/clock.mjs').clock()),
  random: () => require('../modules/random.mjs').random(),
  timer: (s) => (s.fakes.has('timer') ? require('./fake.mjs').fakeTimer() : require('../modules/timer.mjs').timer()),
  fetch: (s) => (s.fakes.has('fetch')
    ? require('./fake.mjs').fakeFetch(s.fakes.get('fetch') || '.', s.grants)
    : require('../modules/fetch.mjs').fetchModule(s.grants, true, require('./resolve.mjs').dispatchers(s.grants))),
  websocket: (s) => (s.fakes.has('websocket')
    ? require('./fake.mjs').fakeWebsocket(s.grants)
    : require('../modules/websocket.mjs').websocket(s.grants, require('./resolve.mjs').guards(s.grants))),
  worker: (s) => require('./worker.mjs').workers(s),
  net: (s) => require('./net.mjs').netModule(s.grants, s.tls),
  process: (s) => require('./process.mjs').processes(s.grants),
  stdin: () => require('./stdin.mjs').stdin(),
  env: (s) => require('./env.mjs').env(s.grants),
  fs: (s) => require('../fs.mjs').fsModule(require('./fs.mjs').nodeFiles(s.grants, s.changes)),
};

const fakeable = new Set(['clock', 'timer', 'fetch', 'websocket']);

// changes counts the renames and removals of the program's threads, which share it.
export const setupOf = (grants) => ({
  grants, fakes: new Map(), tls: null, changes: new Int32Array(new SharedArrayBuffer(4)),
});

// hostFlag adds a flag that sets the host up and returns true, or returns false for any other flag. The flags are
// --fake=NAME,... for clock, timer, websocket and fetch, with fetch:DIR to answer from DIR, and --tls-cert=FILE
// with --tls-key=FILE.
export function hostFlag(setup, flag) {
  if (flag.startsWith('--fake=')) {
    for (const item of listOf(flag.slice(7))) {
      const colon = item.indexOf(':');
      const name = colon < 0 ? item : item.slice(0, colon);
      if (!fakeable.has(name) || (colon >= 0 && name !== 'fetch')) throw new Error(`no fake ${item}`);
      setup.fakes.set(name, colon < 0 ? null : item.slice(colon + 1));
    }
    return true;
  }
  for (const part of ['cert', 'key']) {
    if (!flag.startsWith(`--tls-${part}=`)) continue;
    const file = flag.slice(part.length + 7);
    try {
      (setup.tls ||= {})[part] = fs.readFileSync(file);
    } catch (e) {
      throw new Error(`cannot read ${file}`);
    }
    return true;
  }
  return false;
}

export function hostModules(setup, own = new Map()) {
  const made = new Map(own);
  return {
    has: (name) => made.has(name) || Object.hasOwn(loaders, name),
    get(name) {
      if (!made.has(name)) made.set(name, loaders[name](setup));
      return made.get(name);
    },
    keys: () => Object.keys(loaders),
  };
}
