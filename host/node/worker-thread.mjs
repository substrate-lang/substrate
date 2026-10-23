// A worker's thread on Node: runs its modules, with the worker module's own side and the parent's modules.
import { parentPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { absent, imported, workerSide } from '../worker-side.mjs';
import { loadModule, nameOf } from './modules.mjs';

const side = workerSide((m, transfer) => parentPort.postMessage(m, transfer));

parentPort.on('message', async (m) => {
  if (m.type === 'start') {
    const wasm = new Map(m.modules);
    const needed = imported(wasm);
    const modules = new Map([['worker', side.worker]]);
    for (const spec of m.grants) {
      const name = nameOf(spec);
      if (!needed.has(name) || modules.has(name)) continue;
      modules.set(name, name === 'stdin' ? absent(name, needed.get(name)) : await loadModule(spec));
    }
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
      side.report(`worker.run: no function ${m.entry}`);
      side.ended(2, '');
      return;
    }
    side.started(host, host.call(f, []));
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
});
