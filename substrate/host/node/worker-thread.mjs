// A worker's thread on Node runs the worker's modules, with the worker module's own side and the parent's modules.
import { parentPort } from 'node:worker_threads';
import { createHost } from '../subhost-core.mjs';
import { workerSide } from '../worker-side.mjs';
import { pairsFrom, requestOf } from '../grants.mjs';
import { hostModules, system } from './modules.mjs';
import { resolveGrant } from './fs.mjs';
import { workers } from './worker.mjs';

// The port the parent hears this worker on, and the count of messages posted to it, which the parent waits on.
let reply = null;

const side = workerSide((m, transfer) => {
  reply.port.postMessage(m, transfer);
  Atomics.add(reply.signal, 0, 1);
  Atomics.notify(reply.signal, 0);
});

// In a worker, the worker module starts the worker's own workers and reaches its parent as worker 0.
const nested = (setup) => (caller, app) => {
  const own = workers(setup)(caller, app);
  const parent = side.worker(caller);
  return { ...own, send: (w, p, l) => (w === 0 ? parent.send(w, p, l) : own.send(w, p, l)) };
};

parentPort.on('message', (m) => {
  if (m.type === 'start') {
    reply = m.reply;
    if (m.heard) side.limitOutput();
    const wasm = new Map(m.modules);
    const setup = { grants: m.grants, fakes: new Map(m.fakes), tls: m.tls, loader: m.loader, worker: true };
    const host = createHost({
      args: m.args ?? [m.argument],
      os: system,
      write: side.write,
      worker: true,
      report: side.report,
      ended: side.ended,
      delivered: side.delivered,
      active: side.active,
      modules: hostModules(setup, new Map([['worker', nested(setup)]]), new Set(['stdin', 'signal'])),
      grants: m.grants,
      parseGrants: (list) => requestOf(pairsFrom(list), resolveGrant),
      memoryPages: m.pages,
    });
    const entry = host.load([...wasm.keys()], (name) => wasm.get(name), m.compiled);
    if (!entry) {
      side.ended(2, host.lastError);
      return;
    }
    const exports = host.registry.get(m.entry[0]);
    const f = exports && exports[m.entry[1]];
    if (typeof f !== 'function') {
      side.ended(2, `worker.start: no function ${m.entry[1]} in ${m.entry[0]}`);
      return;
    }
    side.started(host, host.call(f, []));
    if (m.ends) {
      process.on('exit', () => side.ended(0, ''));
      parentPort.unref();
    }
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
});
