// The host module "worker" in a browser: the thread is a Web Worker, given a copy of the page's files.
import { workerModule } from '../worker.mjs';

export function workers() {
  return workerModule({
    spawn(plan, app) {
      const thread = new Worker(new URL('./worker-script.mjs', import.meta.url), { type: 'module' });
      thread.postMessage({
        type: 'start',
        modules: plan.modules,
        entry: plan.entry,
        argument: plan.argument,
        files: app.files,
        cwd: app.cwd,
        grants: plan.grants,
        pages: plan.pages,
        heard: plan.heard,
      });
      return {
        post: (m, transfer) => thread.postMessage(m, transfer),
        terminate: () => thread.terminate(),
        onMessage: (f) => {
          thread.onmessage = (e) => f(e.data);
        },
        onError: (f) => {
          thread.onerror = (e) => {
            e.preventDefault();
            f(`error: ${e.message || 'the worker failed'}`);
          };
        },
      };
    },
  });
}
