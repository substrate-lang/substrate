// A worker's thread on Node runs the worker's modules, with the worker module's own side and the parent's modules.
import { MessageChannel, parentPort, receiveMessageOnPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { workerSide } from '../worker-side.mjs';
import { pairsFrom, requestOf } from '../grants.mjs';
import { hostModules, system } from './modules.mjs';
import { resolveGrant } from './fs.mjs';
import { workers } from './worker.mjs';

const side = workerSide((m, transfer) => parentPort.postMessage(m, transfer));

// A connection to the Chromium of the thread that started this worker, which answers it (browser.mjs, worker.mjs).
const connect = (file, files, args) => {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  parentPort.postMessage({ type: 'browser', file, files, args, reply: port2, signal }, [port2]);
  Atomics.wait(signal, 0, 0, 60000);
  let got = receiveMessageOnPort(port1);
  for (let i = 0; got === undefined && i < 100; i++) {
    Atomics.wait(signal, 0, 1, 10);
    got = receiveMessageOnPort(port1);
  }
  port1.close();
  if (!got) throw new Error('browser.open: the thread that started this worker did not answer');
  if (!got.message.ok) throw new Error(got.message.message);
  return { port: got.message.port, signal: got.message.signal, worker: null, dead: false };
};

// The worker module in a worker: its own workers, and its parent as worker 0.
const nested = (setup) => (caller, app) => {
  const own = workers(setup)(caller, app);
  const parent = side.worker(caller);
  return { ...own, send: (w, p, l) => (w === 0 ? parent.send(w, p, l) : own.send(w, p, l)) };
};

parentPort.on('message', (m) => {
  if (m.type === 'start') {
    if (m.heard) side.limitOutput();
    const wasm = new Map(m.modules);
    const setup = { grants: m.grants, fakes: new Map(m.fakes), tls: m.tls, loader: m.loader, worker: true, connect };
    const host = createHost({
      args: m.args ?? [m.argument],
      os: system,
      write: side.write,
      exit(code) {
        throw new Exit(code);
      },
      report: side.report,
      ended: side.ended,
      delivered: side.delivered,
      active: side.active,
      modules: hostModules(setup, new Map([['worker', nested(setup)]])),
      grants: m.grants,
      parseGrants: (list) => requestOf(pairsFrom(list), resolveGrant),
      absent: new Set(['stdin', 'signal']),
      memoryPages: m.pages,
    });
    const entry = host.load([...wasm.keys()], (name) => wasm.get(name));
    if (!entry) {
      side.report(host.lastError);
      side.ended(2, '');
      return;
    }
    const exports = host.registry.get(m.entry[0]);
    const f = exports && exports[m.entry[1]];
    if (typeof f !== 'function') {
      side.report(`worker.start: no function ${m.entry[1]} in ${m.entry[0]}`);
      side.ended(2, '');
      return;
    }
    side.started(host, host.call(f, []));
    if (m.ends) parentPort.unref();
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
});
