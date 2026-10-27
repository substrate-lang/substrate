// A worker's Web Worker runs the worker's modules, with the worker module's own side and the page's modules that a
// worker can have, within the worker's grants. Its files are a read-only copy of the page's.
import { run } from './subhost-web.mjs';
import { fsModule } from '../fs.mjs';
import { pageFiles } from './fs.mjs';
import { workerSide } from '../worker-side.mjs';

const loaders = {
  clock: () => import('../modules/clock.mjs').then((m) => m.clock()),
  random: () => import('../modules/random.mjs').then((m) => m.random()),
  timer: () => import('../modules/timer.mjs').then((m) => m.timer()),
  fetch: (grants) => import('../modules/fetch.mjs').then((m) => m.fetchModule(grants)),
  websocket: (grants) => import('../modules/websocket.mjs').then((m) => m.websocket(grants)),
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
    symlink: refused,
    copy: refused,
    chmod: refused,
    makeTemp: refused,
    open: (p, mode, start) => (mode === 0 ? files.open(p, mode, start) : refused()),
  };
}

const side = workerSide((m, transfer) => self.postMessage(m, transfer));

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'start') {
    if (m.heard) side.limitOutput();
    const wasm = new Map(m.modules);
    const modules = { worker: side.worker, fs: fsModule(readOnly(pageFiles(m.files, m.cwd, m.grants))) };
    const absent = new Set();
    for (const name of m.names) {
      if (name in modules) continue;
      if (loaders[name]) modules[name] = await loaders[name](m.grants);
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
      grants: m.grants,
      entry: m.entry,
      onEnd: side.ended,
      delivered: side.delivered,
      active: side.active,
    }, [...wasm.keys()], wasm);
    if (app.entry && typeof app.worker !== 'function' && !app.ended) {
      side.report(`worker.start: no function ${m.entry[1]} in ${m.entry[0]}`);
      side.ended(2, '');
      return;
    }
    side.started(app.host, app.started);
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
};
