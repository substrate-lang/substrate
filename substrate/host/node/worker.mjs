// The host module "worker" on Node. A worker is a worker thread set up like its parent's host: it keeps the parent's
// fakes and adds those its grants ask for, and TLS files its grants name replace the parent's. A worker that opens a
// site borrows a connection to this thread's Chromium (browser.mjs).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { workerModule } from '../worker.mjs';

const require = createRequire(import.meta.url);

const read = (file) => {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new Error(`worker.start: cannot read ${file}`);
  }
};

let lent = false;

const lend = (m) => {
  try {
    const c = require('./browser.mjs').connection(m.file, m.files, m.args);
    lent = true;
    m.reply.postMessage({ ok: true, port: c.port, signal: c.signal }, [c.port]);
  } catch (e) {
    m.reply.postMessage({ ok: false, message: e.message });
  }
  Atomics.store(m.signal, 0, 1);
  Atomics.notify(m.signal, 0);
};

export function workerThread(setup, plan, transfer = []) {
  const tls = plan.tls ? { cert: read(plan.tls.cert), key: read(plan.tls.key) } : setup.tls;
  const thread = new Worker(new URL('./worker-thread.mjs', import.meta.url));
  thread.on('message', (m) => {
    if (m.type === 'browser') lend(m);
  });
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
    address: plan.address,
  }, transfer);
  return thread;
}

export function workers(setup) {
  const made = workerModule({
    spawn(plan) {
      const thread = workerThread(setup, plan);
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
  return (caller, app) => {
    const m = made(caller, app);
    return {
      ...m,
      end() {
        m.end();
        if (lent) require('./browser.mjs').endShared();
      },
    };
  };
}
