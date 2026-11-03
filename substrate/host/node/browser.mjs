// The host module "browser" (browser.sub). It opens sites in Chromium, which chromium.mjs drives on another thread, and
// blocks until Chromium answers. One Chromium serves a thread and the workers it starts, which borrow connections to
// it. A test's server runs through serving.mjs. The caller's grants limit what this module reads, runs and reaches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { comparable, literalPath } from './fs.mjs';
import { mayRun, mayUrl } from '../grants.mjs';
import { entries } from '../entries.mjs';

const utf8 = new TextEncoder();
const chromium = new URL('./chromium.mjs', import.meta.url);
const serving = new URL('./serving.mjs', import.meta.url);
const subhost = fileURLToPath(new URL('../subhost.mjs', import.meta.url));
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

const ask = (t, message, transfer = []) => {
  Atomics.store(t.signal, 0, 0);
  t.port.postMessage(message, transfer);
  if (Atomics.wait(t.signal, 0, 0, patience) === 'timed-out') {
    if (t.worker) t.worker.terminate();
    t.dead = true;
    return { ok: false, message: `the browser did not answer within ${patience / 1000} s` };
  }
  let got = receiveMessageOnPort(t.port);
  while (got === undefined) {
    Atomics.wait(t.signal, 0, 1, 10);
    got = receiveMessageOnPort(t.port);
  }
  return got.message;
};

// The thread's Chromium, started by the first site it opens, here or in a worker it started.
let shared = null;

const sharedDriver = (file, files, args) => {
  if (!shared || shared.dead) shared = thread(chromium, 'Chromium', { file, files, args });
  return shared;
};

// A connection to the thread's Chromium for a worker, whose module asks for it with its own grants checked.
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

// connect, in a worker, gives a connection to the Chromium of the thread that started it.
export function browsers(grants, connect = null) {
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

    // A borrowed connection goes back once its browsers have closed, so a worker can end.
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

    const served = (program, site) => {
      if (!mayRun(grants.run, comparable(subhost), subhost)) throw new Error(`browser.open: ${subhost} is not granted (--allow-run), so the server cannot run`);
      const args = ['--stack-size=4000', subhost, '--grant', 'net', '127.0.0.1', '--grant', 'read', site, '--', program, site];
      const t = thread(serving, 'the server', { command: process.execPath, args });
      const reply = ask(t, { type: 'start' });
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

    const stopped = (t) => {
      if (!t.dead) ask(t, { type: 'stop' });
      t.worker.terminate();
    };

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
      open(dp, dl, up, ul, cp, cl, sp, sl, fp, fl, ap, al, err) {
        let server = null;
        try {
          const dir = caller.string(dp, dl);
          let url = caller.string(up, ul);
          if (cl === 0) throw new Error('browser.open: no Chromium was given');
          if (sl > 0) {
            server = served(caller.string(sp, sl), dir);
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
