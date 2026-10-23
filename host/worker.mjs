// The host module "worker": this program, or another program's modules, run on a thread of its own, sharing
// nothing but messages. A worker is planned with new, limit and module, then run, calling one of its functions
// with bytes as its argument. It has its parent's modules; one a thread cannot have traps when called. The
// browser and Node each give their way of starting a thread.
const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

// spawn(plan, app) starts a thread running the plan and returns it: post(message, transfer), terminate(),
// onMessage(f) and onError(f), f given the reason.
export function workerModule({ spawn }) {
  let caller = null;
  const planned = new Map();
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

  const refuse = (message) => {
    caller.error(message);
    return -1;
  };

  function run(w, entry, argument, app) {
    const p = planned.get(w);
    if (!p) return -1;
    planned.delete(w);
    if (p.modules.length === 0) {
      const program = caller.program();
      for (const name of program.names) p.modules.push([name, program.bytes(name)]);
    }
    let thread;
    try {
      thread = spawn({ ...p, entry, argument, grants: [...caller.grants().values()] }, app);
    } catch (e) {
      return refuse(e.message);
    }
    const worker = { thread, tag: p.tag, time: p.time, timer: null };
    alive.set(w, worker);
    thread.onMessage((m) => {
      if (alive.get(w) !== worker) return;
      if (m.type === 'output') deliver(w, p.tag, m.fd === 2 ? STDERR : STDOUT, 0, m.bytes);
      else if (m.type === 'message') deliver(w, p.tag, MESSAGE, 0, m.bytes);
      else if (m.type === 'done') deliver(w, p.tag, DONE, 0, utf8.encode(m.trap));
      else if (m.type === 'busy') limit(w, worker);
      else if (m.type === 'idle') clearTimeout(worker.timer);
      else if (m.type === 'ended') end(w, m.code, m.reason);
    });
    thread.onError((reason) => end(w, -1, reason));
    limit(w, worker);
    return 0;
  }

  return (theCaller, app) => {
    caller = theCaller;
    const string = (ptr, len) => caller.string(ptr, len);
    const bytes = (ptr, len) => caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
    return {
      source: SOURCE,
      end() {
        for (const w of [...alive.keys()]) end(w, -1, null);
        planned.clear();
      },
      new(tag) {
        const w = nextNumber++;
        planned.set(w, { tag, time: 0, pages: 0, modules: [] });
        return w;
      },
      limit(w, ms, size) {
        const p = planned.get(w);
        if (!p) return;
        p.time = ms >>> 0;
        p.pages = Math.ceil((size >>> 0) / 65536);
      },
      module(w, np, nl, bp, bl) {
        const p = planned.get(w);
        if (!p) return -1;
        p.modules.push([string(np, nl), bytes(bp, bl)]);
        return 0;
      },
      run(w, np, nl, bp, bl) {
        return run(w, string(np, nl), bytes(bp, bl), app);
      },
      send(w, ptr, len) {
        const worker = alive.get(w);
        if (!worker) return -1;
        const b = bytes(ptr, len);
        worker.thread.post({ type: 'message', bytes: b }, [b.buffer]);
        return 0;
      },
      stop(w) {
        planned.delete(w);
        end(w, -1, null);
      },
    };
  };
}
