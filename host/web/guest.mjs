// The host module "guest": runs another program in a Web Worker, sharing nothing but messages.
import { resolvePath } from './subhost-web.mjs';
import { isUnder, parseSpec } from '../guest-common.mjs';

const text = new TextDecoder();
const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

export function guests() {
  let app = null;
  let caller = null;

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

    const files = app.files;
    const dir = resolvePath(app.cwd, spec.program);
    const list = files.get(`${dir}/program`);
    if (!list) throw new Error(`guest.start: no program found in ${spec.program}`);
    const names = text.decode(list).split('\n').filter((n) => n !== '');
    const wasm = new Map();
    for (const name of names) {
      const bytes = files.get(`${dir}/${name}.wasm`);
      if (!bytes) throw new Error(`guest.start: the program in ${spec.program} is missing ${name}.wasm`);
      wasm.set(name, bytes);
    }

    const readable = spec.read.map((d) => resolvePath(app.cwd, d));
    const granted = new Map();
    for (const [path, bytes] of files) if (readable.some((d) => isUnder(d, path))) granted.set(path, bytes);

    const g = nextNumber++;
    const worker = new Worker(new URL('./guest-worker.mjs', import.meta.url), { type: 'module' });
    const guest = { worker, time: spec.time, unfinished: 1, timer: null };
    alive.set(g, guest);

    worker.onmessage = (e) => {
      if (alive.get(g) !== guest) return;
      const m = e.data;
      if (m.type === 'output') deliver(g, m.fd === 2 ? STDERR : STDOUT, m.bytes);
      else if (m.type === 'message') deliver(g, MESSAGE, m.bytes);
      else if (m.type === 'done') {
        guest.unfinished--;
        restartTimer(g, guest);
        deliver(g, DONE, utf8.encode(m.trap));
      } else if (m.type === 'ended') end(g, m.reason);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      end(g, `error: ${e.message || 'the worker failed'}`);
    };
    worker.postMessage({
      type: 'start',
      names,
      wasm,
      files: granted,
      args: spec.args,
      cwd: app.cwd,
      writable: spec.write.map((d) => resolvePath(app.cwd, d)),
      memory: spec.memory,
    });
    restartTimer(g, guest);
    return g;
  }

  return (theCaller, theApp) => {
    caller = theCaller;
    app = theApp;
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
