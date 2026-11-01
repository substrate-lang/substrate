// A site's start: the program, given the files in assets.list and files.pack, with the host modules it imports. The
// modules are kept in window.modules, and window.ready is set once the program has started.
import { boot } from './subhost-web.mjs';

const query = new URLSearchParams(location.search);
const root = document.getElementById('root');
const made = {};
const makers = {
  dom: async () => (await import('./dom.mjs')).dom(root),
  audio: async () => (await import('./audio.mjs')).audio(),
  gpu: async () => (await import('./gpu.mjs')).gpu({ dom: await make('dom'), offscreen: query.get('offscreen') === '1' }),
  storage: async () => (await import('./storage.mjs')).storage(location.pathname.replace(/[^/]*$/, '')),
  location: async () => (await import('./location.mjs')).locationModule(),
  clipboard: async () => (await import('./clipboard.mjs')).clipboard(),
  files: async () => (await import('./files.mjs')).files(),
  worker: async () => (await import('./worker.mjs')).workers(),
  clock: async () => (await import('../modules/clock.mjs')).clock(),
  random: async () => (await import('../modules/random.mjs')).random(),
  timer: async () => (await import('../modules/timer.mjs')).timer(),
  fetch: async () => (await import('../modules/fetch.mjs')).fetchModule(),
  websocket: async () => (await import('../modules/websocket.mjs')).websocket(),
};
const make = (name) => (made[name] ||= makers[name]());

window.app = await boot({
  program: 'program/',
  lists: [['assets.list', '/']],
  packs: [['files.pack', '/']],
  async modules(wanted) {
    const modules = {};
    for (const name of wanted) if (Object.hasOwn(makers, name)) modules[name] = await make(name);
    window.modules = modules;
    return modules;
  },
});
window.ready = true;
