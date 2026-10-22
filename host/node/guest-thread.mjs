// A guest's worker thread on Node: runs one program, with the guest module's worker side.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { guestSide, isUnder } from '../guest-side.mjs';

const side = guestSide((m, transfer) => parentPort.postMessage(m, transfer));

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return path.join(real(path.dirname(p)), path.basename(p));
  }
};

parentPort.on('message', async (m) => {
  if (m.type === 'start') {
    const readable = m.readable.map(real);
    const writable = m.writable.map(real);
    const may = (dirs, p) => {
      const r = real(path.resolve(p));
      return dirs.some((d) => isUnder(d, r));
    };
    const modules = new Map(Object.entries({ guest: side.guest, ...await side.modules(m.modules) }));
    const host = createHost({
      args: m.args,
      write: side.write,
      readFile(p) {
        if (!may(readable, p)) throw new Error('No such file or directory');
        return fs.readFileSync(p);
      },
      writeFile(p, bytes) {
        if (!may(writable, p)) throw new Error('Permission denied');
        fs.writeFileSync(p, bytes);
      },
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
