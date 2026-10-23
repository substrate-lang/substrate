// The host module "worker": this program, or modules given to it, run on a thread of its own, sharing nothing
// but messages. A worker is planned with new, grant, read, write, limit and module, then run, calling one of its
// functions with bytes as its argument. It gets only what its parent has: folders within the parent's, and
// modules from the parent's grants. The browser and Node each give their way of starting a thread.
const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

export const floorModules = ['clock', 'random', 'timer', 'fetch', 'websocket'];

// spawn(plan, app) starts a thread running the plan and returns it: post(message, transfer), terminate(),
// onMessage(f) and onError(f), f given the reason. place(dir, app) resolves a folder.
export function workerModule({ spawn, place }) {
  let caller = null;
  const planned = new Map();
  const alive = new Map();
  let nextNumber = 1;

  const deliver = (w, tag, kind, bytes) => {
    if (caller) caller.event(kind, w, tag, 0, bytes);
  };

  const end = (w, reason) => {
    const worker = alive.get(w);
    if (!worker) return;
    alive.delete(w);
    clearTimeout(worker.timer);
    worker.thread.terminate();
    caller.forget(w);
    if (reason !== null) deliver(w, worker.tag, ENDED, utf8.encode(reason));
  };

  // The time limit runs while the worker is busy: from its start, and from each call into it.
  const limit = (w, worker) => {
    clearTimeout(worker.timer);
    worker.timer = worker.time > 0 ? setTimeout(() => end(w, `time limit exceeded (${worker.time} ms)`), worker.time) : null;
  };

  const refuse = (message) => {
    caller.error(message);
    return -1;
  };

  const plan = (w) => planned.get(w);

  const bounds = () => {
    if (!caller.grants().has('fs')) return { read: [], write: [] };
    const fs = caller.module('fs');
    return (fs && fs.bounds) || {};
  };

  const within = (dirs, path) => !dirs || dirs.some((dir) => path === dir || path.startsWith(dir === '/' ? dir : `${dir}/`));

  function run(w, entry, argument, app) {
    const p = plan(w);
    if (!p) return -1;
    planned.delete(w);
    if (p.modules.length === 0) {
      const program = caller.program();
      for (const name of program.names) p.modules.push([name, program.bytes(name)]);
    }
    let thread;
    try {
      thread = spawn({ ...p, entry, argument }, app);
    } catch (e) {
      return refuse(e.message);
    }
    const worker = { thread, tag: p.tag, time: p.time, timer: null };
    alive.set(w, worker);
    thread.onMessage((m) => {
      if (alive.get(w) !== worker) return;
      if (m.type === 'output') deliver(w, p.tag, m.fd === 2 ? STDERR : STDOUT, m.bytes);
      else if (m.type === 'message') deliver(w, p.tag, MESSAGE, m.bytes);
      else if (m.type === 'done') deliver(w, p.tag, DONE, utf8.encode(m.trap));
      else if (m.type === 'busy') limit(w, worker);
      else if (m.type === 'idle') clearTimeout(worker.timer);
      else if (m.type === 'ended') end(w, m.reason);
    });
    thread.onError((reason) => end(w, reason));
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
        for (const w of [...alive.keys()]) end(w, null);
        planned.clear();
      },
      new(tag) {
        const w = nextNumber++;
        planned.set(w, { tag, grants: [], read: [], write: [], time: 0, pages: 0, modules: [] });
        return w;
      },
      grant(w, ptr, len) {
        const p = plan(w);
        const name = string(ptr, len);
        if (!p) return -1;
        if (!floorModules.includes(name) || !caller.grants().has(name)) return refuse(`worker.grant: no module ${name} to grant`);
        p.grants.push(caller.grants().get(name));
        return 0;
      },
      read(w, ptr, len) {
        const p = plan(w);
        if (!p) return -1;
        const dir = string(ptr, len);
        const placed = place(dir, app);
        if (!within(bounds().read, placed)) return refuse(`worker.read: the parent cannot read ${dir}`);
        p.read.push(placed);
        return 0;
      },
      write(w, ptr, len) {
        const p = plan(w);
        if (!p) return -1;
        const dir = string(ptr, len);
        const placed = place(dir, app);
        if (!within(bounds().write, placed)) return refuse(`worker.write: the parent cannot write ${dir}`);
        p.write.push(placed);
        return 0;
      },
      limit(w, ms, size) {
        const p = plan(w);
        if (!p) return;
        p.time = ms >>> 0;
        p.pages = Math.ceil((size >>> 0) / 65536);
      },
      module(w, np, nl, bp, bl) {
        const p = plan(w);
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
        end(w, null);
      },
    };
  };
}
