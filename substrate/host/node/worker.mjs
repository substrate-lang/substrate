// The host module "worker" on Node. A worker is a worker thread set up like its parent's host: it keeps the parent's
// fakes and adds those its grants ask for, and TLS files its grants name replace the parent's. A worker that opens a
// site borrows a connection to this thread's Chromium (browser.mjs).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
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
    reply: plan.reply,
  }, transfer);
  return thread;
}

// The next message on port, which the thread posting to it counts in signal, waiting up to ms for one.
function receivedOn(port, signal, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const seen = Atomics.load(signal, 0);
    const got = receiveMessageOnPort(port);
    if (got) return got.message;
    const left = until - Date.now();
    if (left <= 0) return undefined;
    Atomics.wait(signal, 0, seen, Math.min(left, 50));
  }
}

export function workers(setup) {
  const made = workerModule({
    spawn(plan) {
      const { port1, port2 } = new MessageChannel();
      const signal = new Int32Array(new SharedArrayBuffer(4));
      const thread = workerThread(setup, { ...plan, reply: { port: port2, signal } }, [port2]);
      return {
        post: (m, transfer) => thread.postMessage(m, transfer),
        terminate: () => {
          thread.terminate();
          port1.close();
        },
        receive: (ms) => receivedOn(port1, signal, ms),
        onMessage: (f) => port1.on('message', f),
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
