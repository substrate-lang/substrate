// A guest's worker thread on Node: runs one program, its output sent to the parent in batches.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { createHost, Exit } from '../subhost-core.mjs';
import { batcher, isUnder } from '../guest-common.mjs';

const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;

let host = null;
let ended = false;

const out = batcher((fd, bytes) => parentPort.postMessage({ type: 'output', fd, bytes }, [bytes.buffer]));

const guest = (caller) => ({
  source: SOURCE,
  start() {
    caller.error('guest.start: a guest cannot start guests of its own');
    return 0;
  },
  send(g, ptr, length) {
    if (g !== 0) return -1;
    out.flush();
    const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + length);
    parentPort.postMessage({ type: 'message', bytes }, [bytes.buffer]);
    return 0;
  },
  stop() {},
});

function reportDone(result) {
  out.flush();
  if (!ended) parentPort.postMessage({ type: 'done', trap: result === false ? host.lastError : '' });
}

function endWith(reason) {
  ended = true;
  out.flush();
  parentPort.postMessage({ type: 'ended', reason });
}

parentPort.on('message', (m) => {
  if (m.type === 'start') {
    const may = (dirs, p) => dirs.some((d) => isUnder(d, path.resolve(p)));
    host = createHost({
      args: m.args,
      write(fd, bytes) {
        out.output(fd, bytes);
      },
      readFile(p) {
        if (!may(m.readable, p)) throw new Error('No such file or directory');
        return fs.readFileSync(p);
      },
      writeFile(p, bytes) {
        if (!may(m.writable, p)) throw new Error('Permission denied');
        fs.writeFileSync(p, bytes);
      },
      exit(code) {
        throw new Exit(code);
      },
      report(message) {
        out.output(2, utf8.encode(`error: ${message}\n`));
      },
      ended: endWith,
      delivered(event, ok) {
        if (event.source === SOURCE && event.id === 0) reportDone(ok);
      },
      modules: new Map([['guest', guest]]),
      memoryPages: m.memory * 16,
    });
    let names;
    try {
      names = fs.readFileSync(`${m.dir}/program`, 'utf8').split('\n').filter((n) => n !== '');
    } catch (e) {
      endWith(`no program found in ${m.dir}`);
      return;
    }
    const entry = host.load(names, (name) => fs.readFileSync(`${m.dir}/${name}.wasm`));
    if (!entry) {
      out.output(2, utf8.encode(`error: ${host.lastError}\n`));
      endWith('exit 2');
      return;
    }
    reportDone(typeof entry.main === 'function' ? host.call(entry.main, []) : undefined);
  } else if (m.type === 'message' && host && !ended) {
    host.event(SOURCE, MESSAGE, 0, 0, m.bytes);
  }
});
