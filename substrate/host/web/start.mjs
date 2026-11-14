// Starts a site's program with the files in files.pack, the URL's arg parameters as its arguments, and the host modules
// it imports. The program, files.pack and assets.list sit beside the host directory. The assets load from the site
// when the program asks for them. It sets window.modules, sets window.ready once the program has started, and sets
// window.ended to the program's exit status and window.endReason to why it ended. A page can set window.startOptions
// before this script runs: args replaces the program's arguments, active is called as the program starts and stops
// running, wrap(name, module) gives the module to use in place of each one made, and gpu holds the GPU module's options
// (gpu.mjs).
import { boot } from './subhost-web.mjs';
import { allGrants } from '../grants.mjs';

const given = window.startOptions || {};
const query = new URLSearchParams(location.search);
const grants = allGrants();
const root = document.getElementById('root');
const built = new URL('../../', import.meta.url);
const made = {};
const makers = {
  dom: async () => (await import('./dom.mjs')).dom(root),
  audio: async () => (await import('./audio.mjs')).audio(),
  gpu: async () => (await import('./gpu.mjs')).gpu({ dom: await make('dom'), ...given.gpu }),
  storage: async () => (await import('./storage.mjs')).storage(location.pathname.replace(/[^/]*$/, '')),
  location: async () => (await import('./location.mjs')).locationModule(),
  history: async () => (await import('./history.mjs')).historyModule(),
  clipboard: async () => (await import('./clipboard.mjs')).clipboard(),
  files: async () => (await import('./files.mjs')).files(),
  worker: async () => (await import('./worker.mjs')).workers(),
  clock: async () => (await import('../modules/clock.mjs')).clock(),
  random: async () => (await import('../modules/random.mjs')).random(),
  timer: async () => (await import('../modules/timer.mjs')).timer(),
  fetch: async () => (await import('../modules/fetch.mjs')).fetchModule(grants),
  websocket: async () => (await import('../modules/websocket.mjs')).websocket(grants),
};
const make = (name) => (made[name] ||= makers[name]());

window.app = await boot({
  program: new URL('program/', built).href,
  packs: [[new URL('files.pack', built).href, '/']],
  assets: new URL('assets.list', built).href,
  site: document.baseURI,
  args: given.args || query.getAll('arg'),
  active: given.active,
  grants,
  onEnd: (code, reason) => {
    window.ended = code;
    window.endReason = reason;
  },
  async modules(wanted) {
    const names = [...wanted].filter((name) => Object.hasOwn(makers, name));
    const ready = await Promise.all(names.map(make));
    const modules = Object.fromEntries(names.map((name, i) => [name, given.wrap ? given.wrap(name, ready[i]) : ready[i]]));
    window.modules = modules;
    return modules;
  },
});
window.ready = true;
