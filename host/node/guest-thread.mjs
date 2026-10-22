// A guest's worker thread on Node: runs one program, with the guest module's worker side.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { fsModule } from '../fs.mjs';
import { guestSide } from '../guest-side.mjs';
import { nodeFiles } from './fs.mjs';

const side = guestSide((m, transfer) => parentPort.postMessage(m, transfer));

parentPort.on('message', async (m) => {
  if (m.type === 'start') {
    const files = nodeFiles();
    const modules = new Map(Object.entries({
      guest: side.guest,
      fs: fsModule(files, { read: m.readable.map(files.resolve), write: m.writable.map(files.resolve) }),
      ...await side.modules(m.modules),
    }));
    const host = createHost({
      args: m.args,
      write: side.write,
      exit(code) {
        throw new Exit(code);
      },
      report: side.report,
      ended: side.ended,
      delivered: side.delivered,
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
