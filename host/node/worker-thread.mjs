// A worker's thread on Node runs the worker's modules, with the worker module's own side and the parent's modules.
import { parentPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { workerSide } from '../worker-side.mjs';
import { grantsOf } from '../grants.mjs';
import { hostModules } from './modules.mjs';
import { realPath } from './fs.mjs';

const side = workerSide((m, transfer) => parentPort.postMessage(m, transfer));

parentPort.on('message', (m) => {
  if (m.type === 'start') {
    if (m.heard) side.limitOutput();
    const wasm = new Map(m.modules);
    const setup = { grants: m.grants, fakes: new Map(m.fakes), tls: m.tls, changes: m.changes };
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
      modules: hostModules(setup, new Map([['worker', side.worker]])),
      grants: m.grants,
      parseGrants: (list) => grantsOf(list, realPath),
      absent: new Set(['stdin']),
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
