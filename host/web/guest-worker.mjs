// A guest's Web Worker: runs one program, its output sent to the page in batches.
import { run } from './subhost-web.mjs';
import { batcher, isUnder } from '../guest-common.mjs';

const SOURCE = 3;
const MESSAGE = 1;

let app = null;

const out = batcher((fd, bytes) => self.postMessage({ type: 'output', fd, bytes }, [bytes.buffer]));

const guest = (caller) => ({
  source: SOURCE,
  start() {
    caller.error('guest.start: a guest cannot start guests of its own');
    return 0;
  },
  send(g, ptr, length) {
    if (g !== 0) return -1;
    out.flush();
    const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + length);
    self.postMessage({ type: 'message', bytes }, [bytes.buffer]);
    return 0;
  },
  stop() {},
});

function reportDone(result) {
  out.flush();
  if (!app.ended) self.postMessage({ type: 'done', trap: result === false ? app.host.lastError : '' });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    app = run({
      args: m.args,
      files: m.files,
      cwd: m.cwd,
      output: out.output,
      mayWrite: (path) => m.writable.some((dir) => isUnder(dir, path)),
      memoryPages: m.memory * 16,
      modules: { guest },
      onEnd(reason) {
        out.flush();
        self.postMessage({ type: 'ended', reason });
      },
      delivered(event, ok) {
        if (event.source === SOURCE && event.id === 0) reportDone(ok);
      },
    }, m.names, m.wasm);
    reportDone(app.started);
  } else if (m.type === 'message' && app && !app.ended) {
    app.host.event(SOURCE, MESSAGE, 0, 0, m.bytes);
  }
};
