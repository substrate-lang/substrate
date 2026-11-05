// Fake clock, timer, fetch and websocket modules for tests, on any host. The fake fetch answers with files from a
// directory, and the fake websocket sends back each message it gets. Time jumps to the next timer once there is no
// other work to do. Fetches and connections still need the program's net grants.
import { errors } from '../errors.mjs';
import { entries } from '../entries.mjs';
import { mayUrl } from '../grants.mjs';

const utf8 = new TextEncoder();

const later = globalThis.setImmediate ? (f) => globalThis.setImmediate(f) : (() => {
  const channel = new MessageChannel();
  const queue = [];
  channel.port1.onmessage = () => queue.shift()();
  return (f) => {
    queue.push(f);
    channel.port2.postMessage(null);
  };
})();

// fakeModules makes the fakes a program was set up with, which share one clock. read(dir, path) gives the bytes of
// the file the fake fetch answers with, and throws when there is no such file.
export function fakeModules(setup, read) {
  let now = 0;
  const work = [];
  const timers = new Map();
  let scheduled = false;

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    later(run);
  };

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

  const clock = () => () => ({
    now: () => 1700000000000 + now,
    monotonic: () => now,
  });

  const timer = () => {
    let next = 1;
    return (caller) => ({
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
    });
  };

  const fetch = (root) => (caller) => ({
    source: 6,
    start(mp, ml, up, ul, hp, hl, bp, bl, tag) {
      const url = new URL(caller.string(up, ul), 'http://fake/');
      if (!mayUrl(setup.grants.net, url)) {
        const id = caller.streams.add(tag, { pull: async () => null, close() {} });
        caller.streams.drop(id);
        const why = utf8.encode(`fetch: ${url.host} is not granted (--allow-net)`);
        soon(() => caller.event(2, id, tag, errors.notGranted, why));
        return id;
      }
      let status = 200;
      let body;
      try {
        body = read(root, url.pathname);
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
        if (caller.streams.open(id)) caller.event(1, id, tag, status, utf8.encode(`content-length\0${body.length}\0`));
      });
      return id;
    },
  });

  const websocket = () => {
    const open = new Map();
    let next = 1;
    return (caller) => ({
      source: 7,
      end() {
        open.clear();
      },
      connect(up, ul, pp, pl, hp, hl, tag, err) {
        const url = new URL(caller.string(up, ul));
        if (!mayUrl(setup.grants.net, url)) {
          caller.fail(err, `websocket.connect: ${url.host} is not granted (--allow-net)`);
          return 0;
        }
        const [protocol = ''] = entries(caller.string(pp, pl));
        const id = next++;
        open.set(id, tag);
        soon(() => {
          if (open.has(id)) caller.event(1, id, tag, 0, utf8.encode(protocol));
        });
        return id;
      },
      send(id, ptr, len, kind) {
        if (!open.has(id)) return -1;
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
        soon(() => {
          if (open.has(id)) caller.event(2, id, open.get(id), kind, bytes);
        });
        return 0;
      },
      close(id) {
        open.delete(id);
        caller.forget(id);
      },
    });
  };

  const made = { clock, timer, fetch, websocket };
  return new Map([...setup.fakes].map(([name, item]) => [name, made[name](item || '.')]));
}
