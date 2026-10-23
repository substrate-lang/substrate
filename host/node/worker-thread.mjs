// A worker's thread on Node: runs its modules, with the worker module's own side and the parent's modules.
import { parentPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { workerSide } from '../worker-side.mjs';
import { grantedModules, nameOf } from './modules.mjs';

const side = workerSide((m, transfer) => parentPort.postMessage(m, transfer));

parentPort.on('message', (m) => {
  if (m.type === 'start') {
    const wasm = new Map(m.modules);
    const grants = new Map(m.grants.map((spec) => [nameOf(spec), spec]));
    const modules = grantedModules(grants, new Map([['worker', side.worker]]));
    const host = createHost({
      args: [m.argument],
      write: side.write,
      exit(code) {
        throw new Exit(code);
      },
      report: side.report,
      ended: side.ended,
      delivered: side.delivered,
      active: side.active,
      modules,
      absent: new Set(grants.has('stdin') ? ['stdin'] : []),
      memoryPages: m.pages,
    });
    const entry = host.load([...wasm.keys()], (name) => wasm.get(name));
    if (!entry) {
      side.report(host.lastError);
      side.ended(2, '');
      return;
    }
    const f = entry[m.entry];
    if (typeof f !== 'function') {
      side.report(`worker.start: no function ${m.entry}`);
      side.ended(2, '');
      return;
    }
    side.started(host, host.call(f, []));
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
});
