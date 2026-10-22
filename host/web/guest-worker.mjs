// A guest's Web Worker: runs one program, with the guest module's worker side.
import { run } from './subhost-web.mjs';
import { guestSide } from '../guest-side.mjs';

const floor = {
  clock: () => import('../modules/clock.mjs').then((m) => m.clock()),
  random: () => import('../modules/random.mjs').then((m) => m.random()),
  timer: () => import('../modules/timer.mjs').then((m) => m.timer()),
  fetch: () => import('../modules/fetch.mjs').then((m) => m.fetchModule()),
  websocket: () => import('../modules/websocket.mjs').then((m) => m.websocket()),
};

const side = guestSide((m, transfer) => self.postMessage(m, transfer));

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'start') {
    const modules = { guest: side.guest };
    for (const name of m.modules) modules[name] = await floor[name]();
    const app = run({
      args: m.args,
      files: m.files,
      cwd: m.cwd,
      output: side.write,
      writable: m.writable,
      memoryPages: m.memory * 16,
      modules,
      onEnd: side.ended,
      delivered: side.delivered,
      active: side.active,
    }, m.names, m.wasm);
    side.started(app.host, app.started);
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
};
