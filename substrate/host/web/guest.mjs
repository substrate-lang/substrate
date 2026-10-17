// The host module "guest": runs another program in a Web Worker, sharing nothing but messages.
import { resolvePath } from './subhost-web.mjs';

const text = new TextDecoder();
const utf8 = new TextEncoder();

const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

function parseSpec(spec) {
  const result = { program: null, args: [], read: [], write: [], time: 0, memory: 0 };
  const positiveInteger = (word, value) => {
    if (!/^[0-9]+$/.test(value) || Number(value) === 0) {
      throw new Error(`guest.start: "${word}" needs a positive whole number, not "${value}"`);
    }
    return Number(value);
  };
  for (const line of spec.split('\n')) {
    if (line.trim() === '') continue;
    const space = line.indexOf(' ');
    const word = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (word === 'program') result.program = value;
    else if (word === 'arg') result.args.push(value);
    else if (word === 'read') result.read.push(value);
    else if (word === 'write') result.write.push(value);
    else if (word === 'time') result.time = positiveInteger(word, value);
    else if (word === 'memory') result.memory = positiveInteger(word, value);
    else throw new Error(`guest.start: unknown setting "${word}" in the spec`);
  }
  if (result.program === null) throw new Error('guest.start: the spec has no "program" line');
  return result;
}

const isUnder = (dir, path) => path === dir || path.startsWith(dir === '/' ? dir : `${dir}/`);

export function guests() {
  let app = null;

  const alive = new Map();
  let nextNumber = 1;

  let eventData = null;

  const deliver = (g, kind, bytes) => {
    const outer = eventData;
    eventData = bytes;
    try {
      app.call('on-guest', g, kind);
    } finally {
      eventData = outer;
    }
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
    const linklets = new Map();
    for (const name of names) {
      const bytes = files.get(`${dir}/${name}.wasm`);
      if (!bytes) throw new Error(`guest.start: the program in ${spec.program} is missing ${name}.wasm`);
      linklets.set(name, bytes);
    }

    // postMessage copies the granted files: the guest cannot change ours.
    const readable = spec.read.map((d) => resolvePath(app.cwd, d));
    const granted = new Map();
    for (const [path, bytes] of files) if (readable.some((d) => isUnder(d, path))) granted.set(path, bytes);

    const g = nextNumber++;
    const worker = new Worker(new URL('./guest-worker.mjs', import.meta.url), { type: 'module' });
    const guest = { worker, time: spec.time, unfinished: 1, timer: null };
    alive.set(g, guest);

    worker.onmessage = (e) => {
      // Ignore anything that arrives after the guest was ended.
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
      linklets,
      files: granted,
      args: spec.args,
      cwd: app.cwd,
      writable: spec.write.map((d) => resolvePath(app.cwd, d)),
      memory: spec.memory,
    });
    restartTimer(g, guest);
    return g;
  }

  return (caller, theApp) => {
    app = theApp;
    return {
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
        // slice() copies out of the program's memory; the copy is transferred, not copied again.
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + length);
        guest.worker.postMessage({ type: 'message', bytes }, [bytes.buffer]);
        // An idle guest starts this message now, so its time limit starts now too.
        if (guest.unfinished++ === 0) restartTimer(g, guest);
        return 0;
      },
      take(buf, cap) {
        if (!eventData) return 0;
        caller.memory().set(eventData.subarray(0, cap), caller.u(buf));
        return eventData.length;
      },
      stop(g) {
        end(g, null);
      },
    };
  };
}
