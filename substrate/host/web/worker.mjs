// The host module "worker" in a browser. Each worker runs in a Web Worker, which gets a copy of the page's files and
// the fakes the worker's grants ask for.
import { workerModule } from '../worker.mjs';

export function workers() {
  return workerModule({
    spawn(plan, app) {
      if (plan.tls) throw new Error('worker.start: a page\'s workers cannot have TLS files');
      if (plan.ends) throw new Error('worker.start: a page\'s workers do not end on their own');
      const thread = new Worker(new URL('./worker-script.mjs', import.meta.url), { type: 'module' });
      thread.postMessage({
        type: 'start',
        modules: plan.modules,
        entry: plan.entry,
        argument: plan.argument,
        files: app.files,
        cwd: app.cwd,
        grants: plan.grants,
        fakes: [...plan.fakes],
        names: plan.names,
        pages: plan.pages,
        heard: plan.heard,
        args: plan.args,
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
