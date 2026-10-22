// Fakes of the clock, timer, fetch and websocket modules, for tests: time passes only as timers fire,
// requests are answered from a directory, and a connection echoes what it is sent.
import fs from 'node:fs';
import path from 'node:path';
import { parseRequest } from '../modules/fetch.mjs';

const utf8 = new TextEncoder();

let now = 0;

export function fakeClock() {
  return () => ({
    now: () => 1700000000000 + now,
    monotonic: () => now,
  });
}

export function fakeTimer() {
  return (caller) => {
    const pending = new Map();
    let next = 1;
    let scheduled = false;
    const fire = () => {
      scheduled = false;
      let first = null;
      for (const [id, due] of pending) if (first === null || due < pending.get(first)) first = id;
      if (first === null) return;
      const due = pending.get(first);
      pending.delete(first);
      if (due > now) now = due;
      caller.event(1, first, 0);
      if (pending.size > 0) schedule();
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(fire);
    };
    return {
      source: 5,
      after(ms) {
        const id = next++;
        pending.set(id, now + ms);
        schedule();
        return id;
      },
      cancel(id) {
        pending.delete(id);
      },
    };
  };
}

export function fakeFetch(root) {
  return (caller) => {
    const requests = new Map();
    let next = 1;
    return {
      source: 6,
      start(ptr, len) {
        let request;
        try {
          request = parseRequest(caller.memory().slice(caller.u(ptr), caller.u(ptr) + len));
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
        const id = next++;
        let status = 200;
        let body;
        try {
          body = fs.readFileSync(path.join(root, new URL(request.url, 'http://fake/').pathname));
        } catch (e) {
          status = 404;
          body = utf8.encode('not found');
        }
        const state = { body, at: 0, closed: false };
        requests.set(id, state);
        setImmediate(() => {
          if (!state.closed) caller.event(1, id, status, utf8.encode(`content-length: ${body.length}\n`));
        });
        return id;
      },
      read(id, buf, cap) {
        const state = requests.get(id);
        if (!state) return -1;
        const at = caller.u(buf);
        setImmediate(() => {
          if (state.closed) return;
          const n = Math.min(cap, state.body.length - state.at);
          caller.memory().set(state.body.subarray(state.at, state.at + n), at);
          state.at += n;
          if (n === 0) {
            state.closed = true;
            requests.delete(id);
          }
          caller.event(2, id, n);
        });
        return 0;
      },
      abort(id) {
        const state = requests.get(id);
        if (!state) return;
        state.closed = true;
        requests.delete(id);
      },
    };
  };
}

export function fakeWebsocket() {
  return (caller) => {
    const open = new Set();
    let next = 1;
    return {
      source: 7,
      connect() {
        const id = next++;
        open.add(id);
        setImmediate(() => {
          if (open.has(id)) caller.event(1, id, 0);
        });
        return id;
      },
      send(id, ptr, len) {
        if (!open.has(id)) return -1;
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
        setImmediate(() => {
          if (open.has(id)) caller.event(2, id, 0, bytes);
        });
        return 0;
      },
      close(id, code) {
        if (!open.has(id)) return;
        open.delete(id);
        setImmediate(() => caller.event(3, id, code || 1000));
      },
    };
  };
}
