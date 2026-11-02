// The host module "browser" (browser.sub). It opens sites in the simulated browser (../web/simulated) or in Chromium
// (chromium.mjs), each on another thread, and blocks until they answer. A test's server runs through serving.mjs. The
// caller's grants limit what this module reads, runs and reaches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { comparable, literalPath } from './fs.mjs';
import { mayRun, mayUrl } from '../grants.mjs';
import { entries } from '../entries.mjs';

const utf8 = new TextEncoder();
const simulated = new URL('../web/simulated/browser.mjs', import.meta.url);
const chromium = new URL('./chromium.mjs', import.meta.url);
const serving = new URL('./serving.mjs', import.meta.url);
const subhost = fileURLToPath(new URL('../subhost.mjs', import.meta.url));
const patience = 60000;

// The code each thread runs. If importing the browser fails, the thread answers the first request with the error.
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

export function browsers(grants) {
  return (caller) => {
    const open = new Map();
    let next = 1;
    let driver = null;
    const servers = new Map();
    const read = (p) => fs.readFileSync(literalPath(grants, 'read', p));

    // Reads the site's files. Only Chromium gets host/, since the simulated browser runs its own copy of the web host.
    const filesUnder = (dir, base, into, host) => {
      for (const name of fs.readdirSync(literalPath(grants, 'read', dir)).sort()) {
        const full = path.join(dir, name);
        if (base === '' && name === 'host' && !host) continue;
        if (fs.statSync(full).isDirectory()) filesUnder(full, `${base}/${name}`, into, host);
        else into.push([`${base}/${name}`, read(full)]);
      }
    };

    const ask = (t, message) => {
      Atomics.store(t.signal, 0, 0);
      t.port.postMessage(message);
      if (Atomics.wait(t.signal, 0, 0, patience) === 'timed-out') {
        t.worker.terminate();
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

    const answer = (out, bytes) => {
      const p = caller.give(bytes, caller.u(out) + 4);
      new DataView(caller.memory().buffer).setUint32(caller.u(out), p, true);
    };

    const served = (program, site) => {
      if (!mayRun(grants.run, comparable(subhost), subhost)) throw new Error(`browser.open: ${subhost} is not granted (--allow-run), so the server cannot run`);
      const t = thread(serving, 'the server', { command: process.execPath, args: ['--stack-size=4000', subhost, '-N=127.0.0.1', `-R=${site}`, program, site] });
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

    const openedIn = (file, dir, url, net) => {
      if (!mayRun(grants.run, comparable(file), file)) throw new Error(`browser.open: ${file} is not granted (--allow-run)`);
      if (!driver || driver.dead) driver = thread(chromium, 'Chromium', { file });
      const id = next++;
      const site = [];
      filesUnder(dir, '', site, true);
      const reply = ask(driver, { type: 'open', browser: id, site, url, seed: 1, net });
      if (!reply.ok) throw new Error(reply.message);
      open.set(id, { thread: driver, shared: true });
      return id;
    };

    const openedSimulated = (dir, url, net) => {
      const site = [];
      filesUnder(dir, '', site, false);
      const t = thread(simulated, 'the simulated browser');
      const reply = ask(t, { type: 'open', site, url, seed: 1, net });
      if (!reply.ok) {
        t.worker.terminate();
        throw new Error(reply.message);
      }
      const id = next++;
      open.set(id, { thread: t, shared: false });
      return id;
    };

    return {
      end() {
        for (const b of open.values()) if (!b.shared) b.thread.worker.terminate();
        open.clear();
        for (const t of servers.values()) stopped(t);
        servers.clear();
        if (driver && !driver.dead) {
          ask(driver, { type: 'end' });
          driver.worker.terminate();
        }
        driver = null;
      },
      open(dp, dl, up, ul, cp, cl, sp, sl, err) {
        let server = null;
        try {
          const dir = caller.string(dp, dl);
          let url = caller.string(up, ul);
          if (sl > 0) {
            server = served(caller.string(sp, sl), dir);
            url = new URL(url, `${server.address}index.html`).href;
          }
          const net = server ? grants.net : null;
          const id = cl > 0 ? openedIn(caller.string(cp, cl), dir, url, net) : openedSimulated(dir, url, net);
          if (server) servers.set(id, server);
          return id;
        } catch (e) {
          if (server) stopped(server);
          caller.fail(err, e.message);
          return 0;
        }
      },
      request(id, ptr, len, out, err) {
        const b = open.get(id);
        if (!b || b.thread.dead) {
          caller.fail(err, b ? 'the browser stopped answering' : `no browser ${id} is open`);
          return -1;
        }
        const fields = caller.string(ptr, len);
        const message = { type: 'request', browser: id, fields };
        const [kind, ...paths] = entries(fields);
        if (kind === 'choose-files') {
          try {
            message.files = b.shared ? paths.map((p) => path.resolve(literalPath(grants, 'read', p)))
              : paths.map((p) => [path.basename(p), read(p)]);
          } catch (e) {
            caller.fail(err, e.message);
            return -1;
          }
        }
        const reply = ask(b.thread, message);
        if (!reply.ok) {
          caller.fail(err, reply.message);
          return -1;
        }
        answer(out, reply.bytes ? new Uint8Array(reply.bytes) : utf8.encode(reply.text));
        return 0;
      },
      close(id) {
        const b = open.get(id);
        if (!b) return;
        open.delete(id);
        if (b.shared) ask(b.thread, { type: 'close', browser: id });
        else b.thread.worker.terminate();
        if (servers.has(id)) {
          stopped(servers.get(id));
          servers.delete(id);
        }
      },
    };
  };
}
