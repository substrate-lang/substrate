// The host module "guest" on Node: runs another program in a worker thread, sharing nothing but messages.
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { parseSpec } from '../guest-common.mjs';

const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

export function guests(options = {}) {
  let caller = null;
  const cwd = options.cwd || process.cwd();

  const alive = new Map();
  let nextNumber = 1;

  const deliver = (g, kind, bytes) => {
    if (caller) caller.event(kind, g, 0, bytes);
  };

  const end = (g, reason) => {
    const guest = alive.get(g);
    if (!guest) return;
    alive.delete(g);
    clearTimeout(guest.timer);
    guest.worker.terminate();
    if (reason !== null) deliver(g, ENDED, utf8.encode(reason));
  };

  const restartTimer = (g, guest) => {
    clearTimeout(guest.timer);
    guest.timer = guest.time > 0 && guest.unfinished > 0
      ? setTimeout(() => end(g, `time limit exceeded (${guest.time} ms)`), guest.time)
      : null;
  };

  function start(specText) {
    const spec = parseSpec(specText);
    const g = nextNumber++;
    const worker = new Worker(new URL('./guest-thread.mjs', import.meta.url));
    const guest = { worker, time: spec.time, unfinished: 1, timer: null };
    alive.set(g, guest);
    worker.on('message', (m) => {
      if (alive.get(g) !== guest) return;
      if (m.type === 'output') deliver(g, m.fd === 2 ? STDERR : STDOUT, m.bytes);
      else if (m.type === 'message') deliver(g, MESSAGE, m.bytes);
      else if (m.type === 'done') {
        guest.unfinished--;
        restartTimer(g, guest);
        deliver(g, DONE, utf8.encode(m.trap));
      } else if (m.type === 'ended') end(g, m.reason);
    });
    worker.on('error', (e) => end(g, `error: ${e.message || 'the worker failed'}`));
    worker.on('exit', (code) => end(g, `exit ${code}`));
    worker.postMessage({
      type: 'start',
      dir: path.resolve(cwd, spec.program),
      args: spec.args,
      readable: spec.read.map((d) => path.resolve(cwd, d)),
      writable: spec.write.map((d) => path.resolve(cwd, d)),
      memory: spec.memory,
    });
    restartTimer(g, guest);
    return g;
  }

  return (theCaller) => {
    caller = theCaller;
    return {
      source: SOURCE,
      start(ptr, length) {
        try {
          return start(caller.string(ptr, length));
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
      },
      send(g, ptr, length) {
        const guest = alive.get(g);
        if (!guest) return -1;
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + length);
        guest.worker.postMessage({ type: 'message', bytes }, [bytes.buffer]);
        if (guest.unfinished++ === 0) restartTimer(g, guest);
        return 0;
      },
      stop(g) {
        end(g, null);
      },
    };
  };
}
