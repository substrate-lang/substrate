// A worker's thread on Node runs the worker's modules, with the worker module's own side and the parent's modules.
import { MessageChannel, parentPort, receiveMessageOnPort } from 'node:worker_threads';
import { createHost } from '../subhost-core.mjs';
import { workerSide } from '../worker-side.mjs';
import { pairsFrom, requestOf } from '../grants.mjs';
import { hostModules, system } from './modules.mjs';
import { resolveGrant } from './fs.mjs';
import { workers } from './worker.mjs';

const text = new TextDecoder();

// When the browser module starts a test's server on this thread, the server's first printed line, or why it ended
// before printing one, goes back to the browser module; the rest of its output is dropped.
let answer = null;

const answering = ({ port, signal }) => {
  let line = '';
  let said = '';
  let answered = false;
  const reply = (r) => {
    if (answered) return;
    answered = true;
    port.postMessage(r);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  };
  return (m) => {
    if (m.type === 'output' && m.fd === 2) said = (said + text.decode(m.bytes)).slice(-4000);
    else if (m.type === 'output' && !answered) {
      line += text.decode(m.bytes);
      const k = line.indexOf('\n');
      if (k >= 0) reply({ ok: true, text: line.slice(0, k).trim() });
    } else if ((m.type === 'done' && m.trap) || m.type === 'ended') {
      const why = m.type === 'done' ? m.trap : m.reason || `exit ${m.code}`;
      const tail = said.trim() ? `\n${said.trim()}` : '';
      reply({ ok: false, message: `the server ended before printing its address: ${why}${tail}` });
    }
  };
};

const side = workerSide((m, transfer) => (answer ? answer(m) : parentPort.postMessage(m, transfer)));

// Borrows a connection to the parent thread's Chromium, which lend in worker.mjs provides.
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

// In a worker, the worker module starts the worker's own workers and reaches its parent as worker 0.
const nested = (setup) => (caller, app) => {
  const own = workers(setup)(caller, app);
  const parent = side.worker(caller);
  return { ...own, send: (w, p, l) => (w === 0 ? parent.send(w, p, l) : own.send(w, p, l)) };
};

parentPort.on('message', (m) => {
  if (m.type === 'start') {
    if (m.address) answer = answering(m.address);
    if (m.heard) side.limitOutput();
    const wasm = new Map(m.modules);
    const setup = { grants: m.grants, fakes: new Map(m.fakes), tls: m.tls, loader: m.loader, worker: true, connect };
    const host = createHost({
      args: m.args ?? [m.argument],
      os: system,
      write: side.write,
      worker: true,
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
      side.ended(2, host.lastError);
      return;
    }
    const exports = host.registry.get(m.entry[0]);
    const f = exports && exports[m.entry[1]];
    if (typeof f !== 'function') {
      side.ended(2, `worker.start: no function ${m.entry[1]} in ${m.entry[0]}`);
      return;
    }
    side.started(host, host.call(f, []));
    if (m.ends) parentPort.unref();
  } else if (m.type === 'message') {
    side.message(m.bytes);
  }
});
