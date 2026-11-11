// The host module "worker" (worker.sub). The browser and Node each give spawn, their way of starting a thread.
import { entries } from './entries.mjs';
import { errors, errorOf } from './errors.mjs';
import { askedOf, mayTree, notGranted, within } from './grants.mjs';

const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

// spawn(plan, app) starts a thread running the plan, and returns it with post(message, transfer), terminate(),
// onMessage(f) and onError(f), and on Node receive(ms), which waits up to ms for the thread's next message.
export function workerModule({ spawn }) {
  let caller = null;
  const alive = new Map();
  let nextNumber = 1;
  let started = 0;

  const deliver = (w, tag, kind, value, bytes) => {
    if (caller) caller.event(kind, w, tag, value, bytes);
  };

  // end takes the worker's exit code, or -1 and the reason, and gives its ended event to give; with a null reason,
  // there is no event.
  const end = (w, code, reason, give = null) => {
    const worker = alive.get(w);
    if (!worker) return;
    alive.delete(w);
    clearTimeout(worker.timer);
    worker.thread.terminate();
    caller.forget(w);
    if (reason === null) return;
    if (give) give(ENDED, code, utf8.encode(reason));
    else deliver(w, worker.tag, ENDED, code, utf8.encode(reason));
  };

  // The time limit starts again each time the worker becomes busy.
  const limit = (w, worker) => {
    clearTimeout(worker.timer);
    worker.timer = worker.time > 0
      ? setTimeout(() => end(w, -1, `time limit exceeded (${worker.time} ms)`), worker.time)
      : null;
  };

  // received takes a message from worker w's thread, and gives the event it makes, if any, to give(kind, value, bytes).
  const received = (w, worker, m, give) => {
    if (m.type === 'busy' && worker.owed > 0) {
      worker.owed--;
      started++;
    }
    if (m.type === 'output' && !worker.heard) caller.write(m.fd, m.bytes);
    else if (m.type === 'output') give(m.fd === 2 ? STDERR : STDOUT, 0, m.bytes);
    else if (m.type === 'message') give(MESSAGE, 0, m.bytes);
    else if (m.type === 'done') give(DONE, 0, utf8.encode(m.trap));
    else if (m.type === 'busy') limit(w, worker);
    else if (m.type === 'idle') clearTimeout(worker.timer);
    else if (m.type === 'ended') end(w, m.code, m.reason, give);
  };

  function start(entry, argument, time, pages, heard, tag, app, err, grants, setup) {
    const program = caller.program();
    const modules = program.names.map((name) => [name, program.bytes(name)]);
    const { compiled } = program;
    let thread;
    try {
      thread = spawn({ modules, compiled, entry, argument, grants, names: caller.moduleNames(), pages, heard, ...setup },
                     app);
    } catch (e) {
      caller.fail(err, e.message, errorOf(e));
      return 0;
    }
    const w = nextNumber++;
    const worker = { thread, tag, heard, time, timer: null, owed: 1 };
    alive.set(w, worker);
    thread.onMessage((m) => {
      if (alive.get(w) === worker) received(w, worker, m, (kind, value, bytes) => deliver(w, tag, kind, value, bytes));
    });
    thread.onError((reason, code) => (setup.ends && code === 0 ? end(w, 0, '') : end(w, -1, reason)));
    limit(w, worker);
    return w;
  }

  return (theCaller, app) => {
    caller = theCaller;
    // What workers have been sent and not yet started on, which browser tests wait for as they settle a document.
    if (app && app.realTime) {
      app.realTime.push({ pending: () => [...alive.values()].reduce((n, x) => n + x.owed, 0), progress: () => started });
    }
    const string = (ptr, len) => caller.string(ptr, len);
    const bytes = (ptr, len) => caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
    return {
      source: SOURCE,
      end() {
        for (const w of [...alive.keys()]) end(w, -1, null);
      },
      // f is the function's index in the table; the thread finds it by its module and export name.
      start(f, bp, bl, time, size, heard, tag, gp, gl, err, ends, ap, al) {
        const entry = caller.named(f >>> 0);
        if (!entry) {
          caller.fail(err, 'worker.start: a function of code the program loaded', errors.invalid);
          return 0;
        }
        const pages = Math.ceil((size >>> 0) / 65536);
        let grants;
        let request;
        try {
          request = caller.parseGrants(entries(string(gp, gl)));
          const read = [...request.fakes].filter(([name]) => name === 'fetch').map(([, dir]) => dir || '.');
          if (request.tls) read.push(request.tls.cert, request.tls.key);
          const parent = caller.grants();
          const files = caller.parseGrants(read.flatMap((file) => ['read', file])).grants.read.items;
          for (const file of files) {
            if (!mayTree(parent.read, file)) throw notGranted(`read ${file} reaches beyond the parent's grants`);
          }
          grants = within(askedOf(request, parent), parent);
        } catch (e) {
          caller.fail(err, `worker.start: ${e.message}`, errorOf(e));
          return 0;
        }
        const args = al > 0 ? entries(string(ap, al)) : null;
        const setup = { fakes: request.fakes, tls: request.tls, ends: ends === 1, args };
        return start(entry, bytes(bp, bl), time >>> 0, pages, heard !== 0, tag, app, err, grants, setup);
      },
      send(w, ptr, len) {
        const worker = alive.get(w);
        if (!worker) return -1;
        const b = bytes(ptr, len);
        worker.thread.post({ type: 'message', bytes: b }, [b.buffer]);
        worker.owed++;
        return 0;
      },
      stop(w) {
        end(w, -1, null);
      },
      wait(w, ms, vp, bp) {
        const worker = alive.get(w);
        if (!worker || !worker.thread.receive) return -1;
        const until = Date.now() + (ms >>> 0);
        let got = null;
        while (got === null) {
          const m = worker.thread.receive(Math.max(0, until - Date.now()));
          if (m === undefined) return 0;
          received(w, worker, m, (kind, value, bytes) => {
            got = { kind, value, bytes };
          });
        }
        const p = got.bytes.length > 0 ? caller.give(got.bytes, caller.u(bp) + 4) : 0;
        const view = new DataView(caller.memory().buffer);
        view.setUint32(caller.u(bp), p, true);
        if (p === 0) view.setUint32(caller.u(bp) + 4, 0, true);
        view.setInt32(caller.u(vp), got.value, true);
        return got.kind;
      },
    };
  };
}
