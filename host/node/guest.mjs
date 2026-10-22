// The host module "guest" on Node: the worker is a worker thread, and the program is a directory on disk.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { guestModule } from '../guest.mjs';
import { within } from '../fs.mjs';
import { nodeFiles } from './fs.mjs';

export function guests(options = {}) {
  const cwd = options.cwd || process.cwd();
  const files = nodeFiles();
  const place = (p) => files.resolve(path.isAbsolute(p) ? p : `${cwd}/${p}`);
  const allowed = (dirs, p, how) => {
    const placed = place(p);
    if (!within(dirs, placed)) throw new Error(`guest.start: the parent cannot ${how} ${p}`);
    return placed;
  };
  return guestModule((spec, app, bounds) => {
    const dir = allowed(bounds.read, spec.program, 'read');
    if (!fs.existsSync(`${dir}/program`)) throw new Error(`guest.start: no program found in ${spec.program}`);
    const readable = spec.read.map((d) => allowed(bounds.read, d, 'read'));
    const writable = spec.write.map((d) => allowed(bounds.write, d, 'write'));
    const worker = new Worker(new URL('./guest-thread.mjs', import.meta.url));
    worker.postMessage({ type: 'start', dir, args: spec.args, readable, writable, modules: spec.modules, memory: spec.memory });
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
