// A guest's worker thread on Node: runs one program, with the guest module's worker side.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { fsModule } from '../fs.mjs';
import { guestSide } from '../guest-side.mjs';
import { nodeFiles } from './fs.mjs';
import { loadModule, nameOf } from './modules.mjs';

const side = guestSide((m, transfer) => parentPort.postMessage(m, transfer));

parentPort.on('message', async (m) => {
  if (m.type === 'start') {
    const modules = new Map([['guest', side.guest], ['fs', fsModule(nodeFiles(), { read: m.readable, write: m.writable })]]);
    for (const spec of m.modules) modules.set(nameOf(spec), await loadModule(spec));
    const host = createHost({
      args: m.args,
      write: side.write,
      exit(code) {
        throw new Exit(code);
      },
      report: side.report,
      ended: side.ended,
      delivered: side.delivered,
      active: side.active,
      modules,
      memoryPages: m.memory * 16,
    });
    const names = fs.readFileSync(`${m.dir}/program`, 'utf8').split('\n').filter((n) => n !== '');
    const entry = host.load(names, (name) => fs.readFileSync(`${m.dir}/${name}.wasm`));
    if (!entry) {
      side.report(host.lastError);
      side.ended('exit 2');
      return;
    }
    side.started(host, typeof entry.main === 'function' ? host.call(entry.main, []) : undefined);
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
});
