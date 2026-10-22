// A guest's Web Worker: runs one program, with the guest module's worker side.
import { run } from './subhost-web.mjs';
import { guestSide, isUnder } from '../guest-side.mjs';

const side = guestSide((m, transfer) => self.postMessage(m, transfer));

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'start') {
    const modules = await side.modules(m.modules);
    const app = run({
      args: m.args,
      files: m.files,
      cwd: m.cwd,
      output: side.write,
      mayWrite: (path) => m.writable.some((dir) => isUnder(dir, path)),
      memoryPages: m.memory * 16,
      modules: { guest: side.guest, ...modules },
      onEnd: side.ended,
      delivered: side.delivered,
    }, m.names, m.wasm);
    side.started(app.host, app.started);
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
};
