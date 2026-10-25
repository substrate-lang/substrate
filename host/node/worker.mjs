// The host module "worker" on Node: the thread is a worker thread, set up as its parent's host was.
import { Worker } from 'node:worker_threads';
import { workerModule } from '../worker.mjs';

export function workers(setup) {
  return workerModule({
    spawn(plan) {
      const thread = new Worker(new URL('./worker-thread.mjs', import.meta.url));
      thread.postMessage({
        type: 'start',
        modules: plan.modules,
        entry: plan.entry,
        argument: plan.argument,
        grants: plan.grants,
        fakes: [...setup.fakes],
        tls: setup.tls,
        changes: setup.changes,
        pages: plan.pages,
        heard: plan.heard,
      });
      return {
        post: (m, transfer) => thread.postMessage(m, transfer),
        terminate: () => thread.terminate(),
        onMessage: (f) => thread.on('message', f),
        onError: (f) => {
          thread.on('error', (e) => f(`error: ${e.message || 'the thread failed'}`));
          thread.on('exit', (code) => f(`the thread ended with ${code}`));
        },
      };
    },
  });
}
