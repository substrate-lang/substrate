// The host module "worker": this program's functions run on threads of their own, sharing nothing but messages.
// start runs the named function on a thread, with bytes as the worker's argument, under a time limit and a
// memory limit. A worker has its parent's modules; one a thread cannot have traps when called. The browser and
// Node each give their way of starting a thread.
const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

// spawn(plan, app) starts a thread running the plan: this program's modules, the function, its argument, the
// grants and the memory's pages. It returns the thread: post(message, transfer), terminate(), onMessage(f) and
// onError(f), f given the reason.
export function workerModule({ spawn }) {
  let caller = null;
  const alive = new Map();
  let nextNumber = 1;

  const deliver = (w, tag, kind, value, bytes) => {
    if (caller) caller.event(kind, w, tag, value, bytes);
  };

  // code is the worker's exit code, or -1 with the reason; a null reason ends it without an event.
  const end = (w, code, reason) => {
    const worker = alive.get(w);
    if (!worker) return;
    alive.delete(w);
    clearTimeout(worker.timer);
    worker.thread.terminate();
    caller.forget(w);
    if (reason !== null) deliver(w, worker.tag, ENDED, code, utf8.encode(reason));
  };

  // The time limit runs while the worker is busy: from its start, and from each call into it.
  const limit = (w, worker) => {
    clearTimeout(worker.timer);
    worker.timer = worker.time > 0
      ? setTimeout(() => end(w, -1, `time limit exceeded (${worker.time} ms)`), worker.time)
      : null;
  };

  function start(entry, argument, time, pages, tag, app) {
    const program = caller.program();
    const modules = program.names.map((name) => [name, program.bytes(name)]);
    let thread;
    try {
      thread = spawn({ modules, entry, argument, grants: [...caller.grants().values()], pages }, app);
    } catch (e) {
      caller.error(e.message);
      return 0;
    }
    const w = nextNumber++;
    const worker = { thread, tag, time, timer: null };
    alive.set(w, worker);
    thread.onMessage((m) => {
      if (alive.get(w) !== worker) return;
      if (m.type === 'output') deliver(w, tag, m.fd === 2 ? STDERR : STDOUT, 0, m.bytes);
      else if (m.type === 'message') deliver(w, tag, MESSAGE, 0, m.bytes);
      else if (m.type === 'done') deliver(w, tag, DONE, 0, utf8.encode(m.trap));
      else if (m.type === 'busy') limit(w, worker);
      else if (m.type === 'idle') clearTimeout(worker.timer);
      else if (m.type === 'ended') end(w, m.code, m.reason);
    });
    thread.onError((reason) => end(w, -1, reason));
    limit(w, worker);
    return w;
  }

  return (theCaller, app) => {
    caller = theCaller;
    const string = (ptr, len) => caller.string(ptr, len);
    const bytes = (ptr, len) => caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
    return {
      source: SOURCE,
      end() {
        for (const w of [...alive.keys()]) end(w, -1, null);
      },
      start(np, nl, bp, bl, time, size, tag) {
        return start(string(np, nl), bytes(bp, bl), time >>> 0, Math.ceil((size >>> 0) / 65536), tag, app);
      },
      send(w, ptr, len) {
        const worker = alive.get(w);
        if (!worker) return -1;
        const b = bytes(ptr, len);
        worker.thread.post({ type: 'message', bytes: b }, [b.buffer]);
        return 0;
      },
      stop(w) {
        end(w, -1, null);
      },
    };
  };
}
