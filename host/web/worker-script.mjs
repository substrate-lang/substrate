// A worker's Web Worker: runs its modules, with the worker module's own side and those of the page's modules a
// worker can have. Its files are a copy of the page's, which it cannot write.
import { run } from './subhost-web.mjs';
import { fsModule } from '../fs.mjs';
import { pageFiles } from './fs.mjs';
import { workerSide } from '../worker-side.mjs';

const loaders = {
  clock: () => import('../modules/clock.mjs').then((m) => m.clock()),
  random: () => import('../modules/random.mjs').then((m) => m.random()),
  timer: () => import('../modules/timer.mjs').then((m) => m.timer()),
  fetch: () => import('../modules/fetch.mjs').then((m) => m.fetchModule()),
  websocket: () => import('../modules/websocket.mjs').then((m) => m.websocket()),
};

function readOnly(files) {
  const refused = () => {
    throw new Error('Read-only file system');
  };
  return {
    ...files,
    write: refused,
    makeDir: refused,
    remove: refused,
    rename: refused,
    open: (p, mode) => (mode === 0 ? files.open(p, mode) : refused()),
  };
}

const side = workerSide((m, transfer) => self.postMessage(m, transfer));

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'start') {
    if (m.heard) side.limitOutput();
    const wasm = new Map(m.modules);
    const modules = { worker: side.worker, fs: fsModule(readOnly(pageFiles(m.files, m.cwd))) };
    const absent = new Set();
    for (const name of m.grants) {
      if (name in modules) continue;
      if (loaders[name]) modules[name] = await loaders[name]();
      else absent.add(name);
    }
    const app = run({
      args: [m.argument],
      files: m.files,
      cwd: m.cwd,
      output: side.write,
      memoryPages: m.pages,
      modules,
      absent,
      entry: m.entry,
      onEnd: side.ended,
      delivered: side.delivered,
      active: side.active,
    }, [...wasm.keys()], wasm);
    if (app.entry && typeof app.entry[m.entry] !== 'function' && !app.ended) {
      side.report(`worker.start: no function ${m.entry}`);
      side.ended(2, '');
      return;
    }
    side.started(app.host, app.started);
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
};
