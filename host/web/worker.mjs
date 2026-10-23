// The host module "worker" in a browser: the thread is a Web Worker, and its folders are the page's files.
import { resolvePath } from './fs.mjs';
import { workerModule } from '../worker.mjs';
import { isUnder } from '../fs.mjs';

export function workers() {
  return workerModule({
    place: (p, app) => resolvePath(app.cwd, p),
    spawn(plan, app) {
      const granted = new Map();
      for (const [path, bytes] of app.files) if (plan.read.some((d) => isUnder(d, path))) granted.set(path, bytes);
      const thread = new Worker(new URL('./worker-script.mjs', import.meta.url), { type: 'module' });
      thread.postMessage({
        type: 'start',
        modules: plan.modules,
        entry: plan.entry,
        argument: plan.argument,
        files: granted,
        cwd: app.cwd,
        writable: plan.write,
        grants: plan.grants,
        pages: plan.pages,
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
