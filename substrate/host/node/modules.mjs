// The host modules of a program on Node, each made when first needed, with the program's grants and certificate, and
// with the fakes it was set up with (modules/fake.mjs) in place of the modules they fake.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isLoaderVariable } from '../grants.mjs';

const require = createRequire(import.meta.url);

const loaders = {
  clock: () => require('../modules/clock.mjs').clock(),
  random: () => require('../modules/random.mjs').random(),
  timer: () => require('../modules/timer.mjs').timer(),
  fetch: (s) => require('../modules/fetch.mjs').fetchModule(s.grants, true,
    require('./resolve.mjs').dispatchers(s.grants)),
  websocket: (s) => require('../modules/websocket.mjs').websocket(s.grants, require('./resolve.mjs').guards(s.grants),
    true),
  worker: (s) => require('./worker.mjs').workers(s),
  net: (s) => require('./net.mjs').netModule(s.grants, s.tls),
  process: (s) => require('./process.mjs').processes(s.grants, s.loader, s),
  stdin: () => require('./stdin.mjs').stdin(),
  env: (s) => require('./env.mjs').env(s.grants),
  fs: (s) => require('../fs.mjs').fsModule(require('./fs.mjs').nodeFiles(s.grants)),
  watch: (s) => require('./watch.mjs').watchModule(s.grants),
  signal: () => require('./signal.mjs').signals(),
};

export const system = { darwin: 'macos', win32: 'windows' }[process.platform] ?? process.platform;

// loader holds the dynamic loader's variables as the host started with them.
export const setupOf = (grants) => ({
  grants, fakes: new Map(), tls: null,
  loader: Object.fromEntries(Object.entries(process.env).filter(([name]) => isLoaderVariable(name))),
});

// A file a fake fetch serves: one inside dir once links are followed.
const read = (dir, p) => {
  const root = fs.realpathSync.native(dir);
  const file = fs.realpathSync.native(path.join(root, p));
  const inside = path.relative(root, file);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error('outside the directory');
  }
  return fs.readFileSync(file);
};

export function hostModules(setup, own = new Map()) {
  const made = new Map(own);
  let fakes = null;
  const fake = (name) => {
    fakes ||= require('../modules/fake.mjs').fakeModules(setup, read);
    return fakes.get(name);
  };
  return {
    has: (name) => made.has(name) || Object.hasOwn(loaders, name),
    get(name) {
      if (!made.has(name)) made.set(name, setup.fakes.has(name) ? fake(name) : loaders[name](setup));
      return made.get(name);
    },
    keys: () => Object.keys(loaders),
  };
}
