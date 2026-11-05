// The host module "worker" on Node. A worker is a worker thread set up like its parent's host. It keeps its parent's
// fakes and adds the fakes its grants ask for, and TLS files named in its grants replace the parent's TLS files.
import fs from 'node:fs';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { workerModule } from '../worker.mjs';

const read = (file) => {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new Error(`worker.start: cannot read ${file}`);
  }
};

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
  return workerModule({
    spawn(plan) {
      const { port1, port2 } = new MessageChannel();
      const signal = new Int32Array(new SharedArrayBuffer(4));
      const tls = plan.tls ? { cert: read(plan.tls.cert), key: read(plan.tls.key) } : setup.tls;
      const thread = new Worker(new URL('./worker-thread.mjs', import.meta.url));
      // The messages a thread posted before it ended, which can still wait on the port when its exit is heard.
      let heard = null;
      let closed = false;
      const drained = () => {
        if (closed || !heard) return;
        for (let got = receiveMessageOnPort(port1); got; got = receiveMessageOnPort(port1)) heard(got.message);
      };
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
        reply: { port: port2, signal },
      }, [port2]);
      return {
        post: (m, transfer) => thread.postMessage(m, transfer),
        terminate: () => {
          closed = true;
          thread.terminate();
          port1.close();
        },
        receive: (ms) => receivedOn(port1, signal, ms),
        onMessage: (f) => {
          heard = f;
          port1.on('message', f);
        },
        onError: (f) => {
          thread.on('error', (e) => {
            drained();
            f(`error: ${e.message || 'the thread failed'}`);
          });
          thread.on('exit', (code) => {
            drained();
            f(`the thread ended with ${code}`, code);
          });
        },
      };
    },
  });
}
