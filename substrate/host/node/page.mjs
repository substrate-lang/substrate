// The host module "page" (page.sub): built web programs opened as pages in the simulated browser
// (../web/simulated), each on its own thread. Each call waits for the page's answer. The program's files and the
// page's are read within the caller's grants.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { literalPath } from './fs.mjs';
import { entries } from '../entries.mjs';

const utf8 = new TextEncoder();
const browser = new URL('../web/simulated/browser.mjs', import.meta.url);
const defaultPage = fileURLToPath(new URL('../web/page.html', import.meta.url));
const patience = 60000;

// The thread's code: it imports the browser, and answers with the error when that fails.
const start = `const { workerData } = require('node:worker_threads');
import(${JSON.stringify(browser.href)}).catch((e) => {
  workerData.port.once('message', () => {
    workerData.port.postMessage({ ok: false, message: 'the simulated browser cannot start: ' + (e && e.stack || e) });
    Atomics.store(workerData.signal, 0, 1);
    Atomics.notify(workerData.signal, 0);
  });
});`;

export function pages(grants) {
  return (caller) => {
    const open = new Map();
    let next = 1;
    const read = (p) => fs.readFileSync(literalPath(grants, 'read', p));

    const filesUnder = (dir, base, into) => {
      for (const name of fs.readdirSync(literalPath(grants, 'read', dir)).sort()) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) filesUnder(full, `${base}/${name}`, into);
        else into.push([`${base}/${name}`, read(full)]);
      }
    };

    const ask = (page, message) => {
      Atomics.store(page.signal, 0, 0);
      page.port.postMessage(message);
      if (Atomics.wait(page.signal, 0, 0, patience) === 'timed-out') {
        page.worker.terminate();
        page.dead = true;
        return { ok: false, message: `the page did not answer within ${patience / 1000} s` };
      }
      let got = receiveMessageOnPort(page.port);
      while (got === undefined) {
        Atomics.wait(page.signal, 0, 1, 10);
        got = receiveMessageOnPort(page.port);
      }
      return got.message;
    };

    const answer = (out, text) => {
      const p = caller.give(utf8.encode(text), caller.u(out) + 4);
      new DataView(caller.memory().buffer).setUint32(caller.u(out), p, true);
    };

    return {
      end() {
        for (const page of open.values()) page.worker.terminate();
        open.clear();
      },
      open(dp, dl, mp, ml, ap, al, up, ul, err) {
        let worker = null;
        try {
          const dir = caller.string(dp, dl);
          const url = caller.string(up, ul);
          const names = read(path.join(dir, 'program')).toString().split(/\r?\n/).filter((n) => n !== '');
          const wasm = names.map((n) => [n, read(path.join(dir, `${n}.wasm`))]);
          const markup = read(ml > 0 ? caller.string(mp, ml) : defaultPage).toString();
          const files = [];
          const assets = caller.string(ap, al);
          if (al > 0 && fs.existsSync(literalPath(grants, 'read', assets))) filesUnder(assets, '/assets', files);
          const { port1, port2 } = new MessageChannel();
          const signal = new Int32Array(new SharedArrayBuffer(4));
          worker = new Worker(start, { eval: true, workerData: { port: port2, signal }, transferList: [port2] });
          const page = { worker, port: port1, signal, dead: false };
          const reply = ask(page, { type: 'open', markup, names, wasm, files, url, seed: 1 });
          if (!reply.ok) {
            worker.terminate();
            caller.fail(err, reply.message);
            return 0;
          }
          const id = next++;
          open.set(id, page);
          return id;
        } catch (e) {
          if (worker) worker.terminate();
          caller.fail(err, e.message);
          return 0;
        }
      },
      request(id, ptr, len, out, err) {
        const page = open.get(id);
        if (!page || page.dead) {
          caller.fail(err, page ? 'the page stopped answering' : `no page ${id} is open`);
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
        const reply = ask(page, message);
        if (!reply.ok) {
          caller.fail(err, reply.message);
          return -1;
        }
        answer(out, reply.text);
        return 0;
      },
      close(id) {
        const page = open.get(id);
        if (!page) return;
        page.worker.terminate();
        open.delete(id);
      },
    };
  };
}
