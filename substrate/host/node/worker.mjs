// The host module "worker" on Node: the thread is a worker thread, set up as its parent's host was, with the fakes and
// TLS files its grants ask for.
import fs from 'node:fs';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { workerModule } from '../worker.mjs';

const read = (file) => {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new Error(`worker.start: cannot read ${file}`);
  }
};

export function workers(setup) {
  return workerModule({
    spawn(plan) {
      const tls = plan.tls ? { cert: read(plan.tls.cert), key: read(plan.tls.key) } : setup.tls;
      const thread = new Worker(new URL('./worker-thread.mjs', import.meta.url), { env: SHARE_ENV });
      thread.postMessage({
        type: 'start',
        modules: plan.modules,
        entry: plan.entry,
        argument: plan.argument,
        grants: plan.grants,
        fakes: [...setup.fakes, ...plan.fakes],
        tls,
        loader: setup.loader,
        pages: plan.pages,
        heard: plan.heard,
        ends: plan.ends,
        args: plan.args,
      });
      return {
        post: (m, transfer) => thread.postMessage(m, transfer),
        terminate: () => thread.terminate(),
        onMessage: (f) => thread.on('message', f),
        onError: (f) => {
          thread.on('error', (e) => f(`error: ${e.message || 'the thread failed'}`));
          thread.on('exit', (code) => f(`the thread ended with ${code}`, code));
        },
      };
    },
  });
}
