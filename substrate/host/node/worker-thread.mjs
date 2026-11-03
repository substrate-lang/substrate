// A worker's thread on Node runs the worker's modules, with the worker module's own side and the parent's modules.
import { parentPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { workerSide } from '../worker-side.mjs';
import { pairsFrom, requestOf } from '../grants.mjs';
import { hostModules, system } from './modules.mjs';
import { resolveGrant } from './fs.mjs';
import { workers } from './worker.mjs';

const side = workerSide((m, transfer) => parentPort.postMessage(m, transfer));

// The worker module in a worker: its own workers, and its parent as worker 0.
const nested = (setup) => (caller, app) => {
  const own = workers(setup)(caller, app);
  const parent = side.worker(caller);
  return { ...own, send: (w, p, l) => (w === 0 ? parent.send(w, p, l) : own.send(w, p, l)) };
};

parentPort.on('message', (m) => {
  if (m.type === 'start') {
    if (m.heard) side.limitOutput();
    const wasm = new Map(m.modules);
    const setup = { grants: m.grants, fakes: new Map(m.fakes), tls: m.tls, loader: m.loader, worker: true };
    const host = createHost({
      args: [m.argument],
      os: system,
      write: side.write,
      exit(code) {
        throw new Exit(code);
      },
      report: side.report,
      ended: side.ended,
      delivered: side.delivered,
      active: side.active,
      modules: hostModules(setup, new Map([['worker', nested(setup)]])),
      grants: m.grants,
      parseGrants: (list) => requestOf(pairsFrom(list), resolveGrant),
      absent: new Set(['stdin', 'signal']),
      memoryPages: m.pages,
    });
    const entry = host.load([...wasm.keys()], (name) => wasm.get(name));
    if (!entry) {
      side.report(host.lastError);
      side.ended(2, '');
      return;
    }
    const exports = host.registry.get(m.entry[0]);
    const f = exports && exports[m.entry[1]];
    if (typeof f !== 'function') {
      side.report(`worker.start: no function ${m.entry[1]} in ${m.entry[0]}`);
      side.ended(2, '');
      return;
    }
    side.started(host, host.call(f, []));
    if (m.ends) parentPort.unref();
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
});
