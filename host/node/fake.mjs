// Fakes of the clock, timer, fetch and websocket modules, for tests: one simulated world, where requests
// are answered from a directory, a connection echoes what it is sent, and time passes only when no
// such work is left, as the earliest timer fires.
import fs from 'node:fs';
import path from 'node:path';
import { parseRequest } from '../modules/fetch.mjs';

const utf8 = new TextEncoder();

let now = 0;
const work = [];
const timers = new Map();
let scheduled = false;

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(run);
}

function run() {
  scheduled = false;
  if (work.length > 0) {
    work.shift()();
  } else {
    let first = null;
    for (const [id, t] of timers) if (first === null || t.due < timers.get(first).due) first = id;
    if (first === null) return;
    const t = timers.get(first);
    timers.delete(first);
    if (t.due > now) now = t.due;
    t.fire();
  }
  if (work.length > 0 || timers.size > 0) schedule();
}

const soon = (f) => {
  work.push(f);
  schedule();
};

export function fakeClock() {
  return () => ({
    now: () => 1700000000000 + now,
    monotonic: () => now,
  });
}

export function fakeTimer() {
  let next = 1;
  return (caller) => {
    return {
      source: 5,
      end() {
        timers.clear();
      },
      after(ms, tag) {
        const id = next++;
        timers.set(id, { due: now + ms, fire: () => caller.event(1, id, tag, 0) });
        schedule();
        return id;
      },
      cancel(id) {
        timers.delete(id);
        caller.forget(id);
      },
    };
  };
}

export function fakeFetch(root) {
  return (caller) => ({
    source: 6,
    start(ptr, len, tag) {
      let request;
      try {
        request = parseRequest(caller.memory().slice(caller.u(ptr), caller.u(ptr) + len));
      } catch (e) {
        caller.error(e.message);
        return 0;
      }
      let status = 200;
      let body;
      try {
        body = fs.readFileSync(path.join(root, new URL(request.url, 'http://fake/').pathname));
      } catch (e) {
        status = 404;
        body = utf8.encode('not found');
      }
      let sent = false;
      const id = caller.streams.add(tag, {
        pull: () => new Promise((resolve) => soon(() => {
          resolve(sent ? null : body);
          sent = true;
        })),
        close() {},
      });
      soon(() => {
        if (caller.streams.open(id)) caller.event(1, id, tag, status, utf8.encode(`content-length: ${body.length}\n`));
      });
      return id;
    },
  });
}

export function fakeWebsocket() {
  const open = new Map();
  let next = 1;
  return (caller) => {
    return {
      source: 7,
      end() {
        open.clear();
      },
      connect(ptr, len, tag) {
        const id = next++;
        open.set(id, tag);
        soon(() => {
          if (open.has(id)) caller.event(1, id, tag, 0);
        });
        return id;
      },
      send(id, ptr, len) {
        if (!open.has(id)) return -1;
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
        soon(() => {
          if (open.has(id)) caller.event(2, id, open.get(id), 0, bytes);
        });
        return 0;
      },
      close(id) {
        open.delete(id);
        caller.forget(id);
      },
    };
  };
}
