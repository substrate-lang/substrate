// The host module "browser" (browser.sub). It opens sites in Chromium, which chromium.mjs drives on another thread, and
// each call blocks until Chromium answers. A thread and the workers it starts share one Chromium, through connections
// the workers borrow. A test's server runs on a worker. The caller's grants limit what this module reads, runs and
// reaches.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { comparable, literalPath } from './fs.mjs';
import { mayRun, mayUrl } from '../grants.mjs';
import { entries } from '../entries.mjs';

const require = createRequire(import.meta.url);
const utf8 = new TextEncoder();
const chromium = new URL('./chromium.mjs', import.meta.url);
const patience = 60000;

// The code each thread runs. If importing its module fails, the thread answers the first request with the error.
const start = (script, name) => `const { workerData } = require('node:worker_threads');
import(${JSON.stringify(script.href)}).catch((e) => {
  workerData.port.once('message', () => {
    workerData.port.postMessage({ ok: false, message: ${JSON.stringify(`${name} cannot start: `)} + (e && e.stack || e) });
    Atomics.store(workerData.signal, 0, 1);
    Atomics.notify(workerData.signal, 0);
  });
});`;

function thread(script, name, data = {}) {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(start(script, name), { eval: true, workerData: { port: port2, signal, ...data }, transferList: [port2] });
  return { worker, port: port1, signal, dead: false };
}

const waited = (t, silent) => {
  if (Atomics.wait(t.signal, 0, 0, patience) === 'timed-out') {
    if (t.worker) t.worker.terminate();
    t.dead = true;
    return { ok: false, message: `${silent} within ${patience / 1000} s` };
  }
  let got = receiveMessageOnPort(t.port);
  while (got === undefined) {
    Atomics.wait(t.signal, 0, 1, 10);
    got = receiveMessageOnPort(t.port);
  }
  return got.message;
};

const ask = (t, message, transfer = []) => {
  Atomics.store(t.signal, 0, 0);
  t.port.postMessage(message, transfer);
  return waited(t, 'the browser did not answer');
};

// This thread's Chromium, started when this thread or one of its workers first opens a site.
let shared = null;

const sharedDriver = (file, files, args) => {
  if (!shared || shared.dead) shared = thread(chromium, 'Chromium', { file, files, args });
  return shared;
};

// Lends a worker a connection to this thread's Chromium; the worker's browser module has already checked its grants.
export function connection(file, files, args) {
  const driver = sharedDriver(file, files, args);
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const reply = ask(driver, { type: 'connect', port: port2, signal }, [port2]);
  if (!reply.ok) throw new Error(reply.message);
  return { port: port1, signal };
}

export function endShared() {
  if (shared && !shared.dead) {
    ask(shared, { type: 'end' });
    shared.worker.terminate();
  }
  shared = null;
}

// setup is this thread's host setup. In a worker, setup.connect borrows a connection to the parent thread's Chromium.
export function browsers(setup) {
  const { grants } = setup;
  const connect = setup.connect || null;
  return (caller) => {
    const open = new Set();
    let next = 1;
    let driver = null;
    const servers = new Map();
    const read = (p) => fs.readFileSync(literalPath(grants, 'read', p));

    const filesUnder = (dir, base, into) => {
      for (const name of fs.readdirSync(literalPath(grants, 'read', dir)).sort()) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) filesUnder(full, `${base}/${name}`, into);
        else into.push([`${base}/${name}`, read(full)]);
      }
    };

    // A worker gives its borrowed connection back once its browsers have closed, so that the worker can end.
    const released = () => {
      if (connect && driver && !driver.dead) {
        ask(driver, { type: 'end' });
        driver.port.close();
      }
      driver = null;
    };

    const answer = (out, bytes) => {
      const p = caller.give(bytes, caller.u(out) + 4);
      new DataView(caller.memory().buffer).setUint32(caller.u(out), p, true);
    };

    const writable = (dir) => literalPath(grants, 'write', dir);

    const runnable = (file, what) => {
      if (!mayRun(grants.run, comparable(file), file)) throw new Error(`browser.${what}: ${file} is not granted (--allow-run)`);
    };

    // Runs the server function f on a worker with the caller's grants and the site's directory as its argument. The
    // first line the server prints is its address (see answering in worker-thread.mjs).
    const served = (f, site) => {
      const entry = caller.named(f >>> 0);
      if (!entry) throw new Error('browser.open: the server is a function of code the program loaded');
      const program = caller.program();
      const { port1, port2 } = new MessageChannel();
      const signal = new Int32Array(new SharedArrayBuffer(4));
      const plan = {
        modules: program.names.map((name) => [name, program.bytes(name)]),
        entry,
        grants: caller.grants(),
        fakes: [],
        pages: 0,
        args: [site],
        address: { port: port2, signal },
      };
      const t = { worker: require('./worker.mjs').workerThread(setup, plan, [port2]), port: port1, signal, dead: false };
      const reply = waited(t, 'the server did not print its address');
      if (!reply.ok) {
        t.worker.terminate();
        throw new Error(reply.message);
      }
      t.address = reply.text;
      if (!mayUrl(grants.net, new URL(t.address))) {
        stopped(t);
        throw new Error(`browser.open: ${new URL(t.address).host} is not granted (--allow-net), so the browser cannot reach the server`);
      }
      return t;
    };

    const stopped = (t) => t.worker.terminate();

    const argsOf = (ap, al) => caller.string(ap, al).split(/\s+/).filter(Boolean);

    const opened = (file, files, args, dir, url, net) => {
      runnable(file, 'open');
      if (!driver || driver.dead) driver = (connect || sharedDriver)(file, writable(files), args);
      const id = next++;
      const site = [];
      filesUnder(dir, '', site);
      const reply = ask(driver, { type: 'open', browser: id, site, url, seed: 1, net });
      if (!reply.ok) throw new Error(reply.message);
      open.add(id);
      return id;
    };

    return {
      end() {
        open.clear();
        for (const t of servers.values()) stopped(t);
        servers.clear();
        if (connect) released();
        else endShared();
        driver = null;
      },
      open(dp, dl, up, ul, cp, cl, f, fp, fl, ap, al, err) {
        let server = null;
        try {
          const dir = caller.string(dp, dl);
          let url = caller.string(up, ul);
          if (cl === 0) throw new Error('browser.open: no Chromium was given');
          if (f !== 0) {
            server = served(f, dir);
            url = new URL(url, `${server.address}index.html`).href;
          }
          const id = opened(caller.string(cp, cl), caller.string(fp, fl), argsOf(ap, al), dir, url, server ? grants.net : null);
          if (server) servers.set(id, server);
          return id;
        } catch (e) {
          if (server) stopped(server);
          caller.fail(err, e.message);
          return 0;
        }
      },
      request(id, ptr, len, out, err) {
        if (!open.has(id) || !driver || driver.dead) {
          caller.fail(err, open.has(id) ? 'the browser stopped answering' : `no browser ${id} is open`);
          return -1;
        }
        const fields = caller.string(ptr, len);
        const message = { type: 'request', browser: id, fields };
        const [kind, ...paths] = entries(fields);
        if (kind === 'choose-files') {
          try {
            message.files = paths.map((p) => path.resolve(literalPath(grants, 'read', p)));
          } catch (e) {
            caller.fail(err, e.message);
            return -1;
          }
        }
        const reply = ask(driver, message);
        if (!reply.ok) {
          caller.fail(err, reply.message);
          return -1;
        }
        answer(out, reply.bytes ? new Uint8Array(reply.bytes) : utf8.encode(reply.text));
        return 0;
      },
      close(id) {
        if (!open.has(id)) return;
        open.delete(id);
        if (driver && !driver.dead) ask(driver, { type: 'close', browser: id });
        if (servers.has(id)) {
          stopped(servers.get(id));
          servers.delete(id);
        }
        if (open.size === 0) released();
      },
    };
  };
}
