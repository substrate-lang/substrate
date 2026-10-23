// A worker's Web Worker: runs its modules, with the worker module's own side.
import { run } from './subhost-web.mjs';
import { workerSide } from '../worker-side.mjs';

const floor = {
  clock: () => import('../modules/clock.mjs').then((m) => m.clock()),
  random: () => import('../modules/random.mjs').then((m) => m.random()),
  timer: () => import('../modules/timer.mjs').then((m) => m.timer()),
  fetch: () => import('../modules/fetch.mjs').then((m) => m.fetchModule()),
  websocket: () => import('../modules/websocket.mjs').then((m) => m.websocket()),
};

const side = workerSide((m, transfer) => self.postMessage(m, transfer));

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'start') {
    const modules = { worker: side.worker };
    for (const name of m.grants) modules[name] = await floor[name]();
    const wasm = new Map(m.modules);
    const app = run({
      args: [m.argument],
      files: m.files,
      cwd: m.cwd,
      output: side.write,
      writable: m.writable,
      memoryPages: m.pages,
      modules,
      entry: m.entry,
      onEnd: side.ended,
      delivered: side.delivered,
      active: side.active,
    }, [...wasm.keys()], wasm);
    if (app.entry && typeof app.entry[m.entry] !== 'function' && !app.ended) {
      side.report(`worker.run: no function ${m.entry}`);
      side.ended('exit 2');
      return;
    }
    side.started(app.host, app.started);
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
};
