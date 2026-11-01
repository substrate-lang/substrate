// The host module "browser" (browser.sub): sites, as substrate site builds them, opened in simulated browsers
// (../web/simulated), each on its own thread. Each call waits for the browser's answer. The site's files are read within
// the caller's grants.
import fs from 'node:fs';
import path from 'node:path';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { literalPath } from './fs.mjs';
import { entries } from '../entries.mjs';

const utf8 = new TextEncoder();
const script = new URL('../web/simulated/browser.mjs', import.meta.url);
const patience = 60000;

// The thread's code: it imports the browser, and answers with the error when that fails.
const start = `const { workerData } = require('node:worker_threads');
import(${JSON.stringify(script.href)}).catch((e) => {
  workerData.port.once('message', () => {
    workerData.port.postMessage({ ok: false, message: 'the simulated browser cannot start: ' + (e && e.stack || e) });
    Atomics.store(workerData.signal, 0, 1);
    Atomics.notify(workerData.signal, 0);
  });
});`;

export function browsers(grants) {
  return (caller) => {
    const open = new Map();
    let next = 1;
    const read = (p) => fs.readFileSync(literalPath(grants, 'read', p));

    // The site's files but those of the web host, which the simulated browser has as its own.
    const filesUnder = (dir, base, into) => {
      for (const name of fs.readdirSync(literalPath(grants, 'read', dir)).sort()) {
        const full = path.join(dir, name);
        if (base === '' && name === 'host') continue;
        if (fs.statSync(full).isDirectory()) filesUnder(full, `${base}/${name}`, into);
        else into.push([`${base}/${name}`, read(full)]);
      }
    };

    const ask = (b, message) => {
      Atomics.store(b.signal, 0, 0);
      b.port.postMessage(message);
      if (Atomics.wait(b.signal, 0, 0, patience) === 'timed-out') {
        b.worker.terminate();
        b.dead = true;
        return { ok: false, message: `the browser did not answer within ${patience / 1000} s` };
      }
      let got = receiveMessageOnPort(b.port);
      while (got === undefined) {
        Atomics.wait(b.signal, 0, 1, 10);
        got = receiveMessageOnPort(b.port);
      }
      return got.message;
    };

    const answer = (out, text) => {
      const p = caller.give(utf8.encode(text), caller.u(out) + 4);
      new DataView(caller.memory().buffer).setUint32(caller.u(out), p, true);
    };

    return {
      end() {
        for (const b of open.values()) b.worker.terminate();
        open.clear();
      },
      open(dp, dl, up, ul, err) {
        let worker = null;
        try {
          const dir = caller.string(dp, dl);
          const url = caller.string(up, ul);
          const site = [];
          filesUnder(dir, '', site);
          const { port1, port2 } = new MessageChannel();
          const signal = new Int32Array(new SharedArrayBuffer(4));
          worker = new Worker(start, { eval: true, workerData: { port: port2, signal }, transferList: [port2] });
          const b = { worker, port: port1, signal, dead: false };
          const reply = ask(b, { type: 'open', site, url, seed: 1 });
          if (!reply.ok) {
            worker.terminate();
            caller.fail(err, reply.message);
            return 0;
          }
          const id = next++;
          open.set(id, b);
          return id;
        } catch (e) {
          if (worker) worker.terminate();
          caller.fail(err, e.message);
          return 0;
        }
      },
      request(id, ptr, len, out, err) {
        const b = open.get(id);
        if (!b || b.dead) {
          caller.fail(err, b ? 'the browser stopped answering' : `no browser ${id} is open`);
          return -1;
        }
        const fields = caller.string(ptr, len);
        const message = { type: 'request', fields };
        const [kind, ...paths] = entries(fields);
        if (kind === 'choose-files') {
          try {
            message.files = paths.map((p) => [path.basename(p), read(p)]);
          } catch (e) {
            caller.fail(err, e.message);
            return -1;
          }
        }
        const reply = ask(b, message);
        if (!reply.ok) {
          caller.fail(err, reply.message);
          return -1;
        }
        answer(out, reply.text);
        return 0;
      },
      close(id) {
        const b = open.get(id);
        if (!b) return;
        b.worker.terminate();
        open.delete(id);
      },
    };
  };
}
