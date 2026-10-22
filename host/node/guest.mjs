// The host module "guest" on Node: the worker is a worker thread, and the program is a directory on disk.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { guestModule } from '../guest.mjs';

export function guests(options = {}) {
  const cwd = options.cwd || process.cwd();
  return guestModule((spec) => {
    const dir = path.resolve(cwd, spec.program);
    if (!fs.existsSync(`${dir}/program`)) throw new Error(`guest.start: no program found in ${spec.program}`);
    const worker = new Worker(new URL('./guest-thread.mjs', import.meta.url));
    worker.postMessage({
      type: 'start',
      dir,
      args: spec.args,
      readable: spec.read.map((d) => path.resolve(cwd, d)),
      writable: spec.write.map((d) => path.resolve(cwd, d)),
      modules: spec.modules,
      memory: spec.memory,
    });
    return {
      post: (m, transfer) => worker.postMessage(m, transfer),
      terminate: () => worker.terminate(),
      onMessage: (f) => worker.on('message', f),
      onError: (f) => {
        worker.on('error', (e) => f(`error: ${e.message || 'the worker failed'}`));
        worker.on('exit', (code) => f(`exit ${code}`));
      },
    };
  });
}
