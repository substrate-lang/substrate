// The host module "worker" on Node: the thread is a worker thread.
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { workerModule } from '../worker.mjs';
import { nodeFiles } from './fs.mjs';

export function workers(options = {}) {
  const cwd = options.cwd || process.cwd();
  const files = nodeFiles();
  return workerModule({
    place: (p) => files.resolve(path.isAbsolute(p) ? p : `${cwd}/${p}`),
    spawn(plan) {
      const thread = new Worker(new URL('./worker-thread.mjs', import.meta.url));
      thread.postMessage({
        type: 'start',
        modules: plan.modules,
        entry: plan.entry,
        argument: plan.argument,
        readable: plan.read,
        writable: plan.write,
        grants: plan.grants,
        pages: plan.pages,
      });
      return {
        post: (m, transfer) => thread.postMessage(m, transfer),
        terminate: () => thread.terminate(),
        onMessage: (f) => thread.on('message', f),
        onError: (f) => {
          thread.on('error', (e) => f(`error: ${e.message || 'the thread failed'}`));
          thread.on('exit', (code) => f(`exit ${code}`));
        },
      };
    },
  });
}
