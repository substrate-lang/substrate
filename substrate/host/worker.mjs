// The host module "worker" (worker.sub). The browser and Node each give spawn, their way of starting a thread.
import { entries } from './entries.mjs';
import { askedOf, within } from './grants.mjs';

const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

// spawn(plan, app) starts a thread running the plan, and returns it with post(message, transfer), terminate(),
// onMessage(f) and onError(f).
export function workerModule({ spawn }) {
  let caller = null;
  const alive = new Map();
  let nextNumber = 1;
  let started = 0;

  const deliver = (w, tag, kind, value, bytes) => {
    if (caller) caller.event(kind, w, tag, value, bytes);
  };

  // end takes the worker's exit code, or -1 and the reason; with a null reason, no event is sent.
  const end = (w, code, reason) => {
    const worker = alive.get(w);
    if (!worker) return;
    alive.delete(w);
    clearTimeout(worker.timer);
    worker.thread.terminate();
    caller.forget(w);
    if (reason !== null) deliver(w, worker.tag, ENDED, code, utf8.encode(reason));
  };

  // The time limit starts again each time the worker becomes busy.
  const limit = (w, worker) => {
    clearTimeout(worker.timer);
    worker.timer = worker.time > 0
      ? setTimeout(() => end(w, -1, `time limit exceeded (${worker.time} ms)`), worker.time)
      : null;
  };

  function start(entry, argument, time, pages, heard, tag, app, err, grants, setup) {
    const program = caller.program();
    const modules = program.names.map((name) => [name, program.bytes(name)]);
    let thread;
    try {
      thread = spawn({ modules, entry, argument, grants, names: caller.moduleNames(), pages, heard, ...setup }, app);
    } catch (e) {
      caller.fail(err, e.message);
      return 0;
    }
    const w = nextNumber++;
    const worker = { thread, tag, time, timer: null, owed: 1 };
    alive.set(w, worker);
    thread.onMessage((m) => {
      if (alive.get(w) !== worker) return;
      if (m.type === 'busy' && worker.owed > 0) {
        worker.owed--;
        started++;
      }
      if (m.type === 'output' && !heard) caller.write(m.fd, m.bytes);
      else if (m.type === 'output') deliver(w, tag, m.fd === 2 ? STDERR : STDOUT, 0, m.bytes);
      else if (m.type === 'message') deliver(w, tag, MESSAGE, 0, m.bytes);
      else if (m.type === 'done') deliver(w, tag, DONE, 0, utf8.encode(m.trap));
      else if (m.type === 'busy') limit(w, worker);
      else if (m.type === 'idle') clearTimeout(worker.timer);
      else if (m.type === 'ended') end(w, m.code, m.reason);
    });
    thread.onError((reason, code) => (setup.ends && code === 0 ? end(w, 0, '') : end(w, -1, reason)));
    limit(w, worker);
    return w;
  }

  return (theCaller, app) => {
    caller = theCaller;
    // What workers have been sent and not yet started on, which browser tests wait for as they settle a page.
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
      start(f, bp, bl, time, size, heard, tag, gp, gl, err, ends) {
        const entry = caller.named(f >>> 0);
        if (!entry) {
          caller.fail(err, 'worker.start: a function of code the program loaded');
          return 0;
        }
        const pages = Math.ceil((size >>> 0) / 65536);
        let grants;
        let request;
        try {
          request = caller.parseGrants(entries(string(gp, gl)));
          const read = [...request.fakes].filter(([name]) => name === 'fetch').map(([, dir]) => dir || '.');
          if (request.tls) read.push(request.tls.cert, request.tls.key);
          within(caller.parseGrants(read.flatMap((file) => ['read', file])).grants, caller.grants());
          grants = within(askedOf(request, caller.grants()), caller.grants());
        } catch (e) {
          caller.fail(err, `worker.start: ${e.message}`);
          return 0;
        }
        const setup = { fakes: request.fakes, tls: request.tls, ends: ends === 1 };
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
    };
  };
}
