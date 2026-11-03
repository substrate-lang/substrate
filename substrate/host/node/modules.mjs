// The host modules of a program on Node, each made when first needed, with the program's grants and the fakes
// and certificate the host was set up with.
import { createRequire } from 'node:module';
import { isLoaderVariable } from '../grants.mjs';

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
    : require('../modules/websocket.mjs').websocket(s.grants, require('./resolve.mjs').guards(s.grants), true)),
  worker: (s) => require('./worker.mjs').workers(s),
  net: (s) => require('./net.mjs').netModule(s.grants, s.tls),
  process: (s) => require('./process.mjs').processes(s.grants, s.loader, s),
  stdin: () => require('./stdin.mjs').stdin(),
  env: (s) => require('./env.mjs').env(s.grants),
  fs: (s) => require('../fs.mjs').fsModule(require('./fs.mjs').nodeFiles(s.grants)),
  watch: (s) => require('./watch.mjs').watchModule(s.grants),
  signal: () => require('./signal.mjs').signals(),
  browser: (s) => require('./browser.mjs').browsers(s.grants, s.connect),
};

export const system = { darwin: 'macos', win32: 'windows' }[process.platform] ?? process.platform;

// loader holds the dynamic loader's variables as the host started with them.
export const setupOf = (grants) => ({
  grants, fakes: new Map(), tls: null,
  loader: Object.fromEntries(Object.entries(process.env).filter(([name]) => isLoaderVariable(name))),
});

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
