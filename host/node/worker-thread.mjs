// A worker's thread on Node: runs its modules, with the worker module's own side.
import { parentPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { fsModule } from '../fs.mjs';
import { workerSide } from '../worker-side.mjs';
import { nodeFiles } from './fs.mjs';
import { loadModule, nameOf } from './modules.mjs';

const side = workerSide((m, transfer) => parentPort.postMessage(m, transfer));

parentPort.on('message', async (m) => {
  if (m.type === 'start') {
    const modules = new Map([['worker', side.worker], ['fs', fsModule(nodeFiles(), { read: m.readable, write: m.writable })]]);
    for (const spec of m.grants) modules.set(nameOf(spec), await loadModule(spec));
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
    const wasm = new Map(m.modules);
    const entry = host.load([...wasm.keys()], (name) => wasm.get(name));
    if (!entry) {
      side.report(host.lastError);
      side.ended('exit 2');
      return;
    }
    const f = entry[m.entry];
    if (typeof f !== 'function') {
      side.report(`worker.run: no function ${m.entry}`);
      side.ended('exit 2');
      return;
    }
    side.started(host, host.call(f, []));
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
});
