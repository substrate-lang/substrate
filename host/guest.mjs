// The host module "guest": runs another program in a worker, sharing nothing but messages. The
// browser and Node each give it their way of starting a worker. A guest gets only what its parent has: its
// program and folders must be within the parent's, and its modules are the parent's grants.
import { settings } from './settings.mjs';

const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

export const floorModules = ['clock', 'random', 'timer', 'fetch', 'websocket'];

export function parseSpec(spec) {
  const result = { program: null, args: [], read: [], write: [], modules: [], time: 0, memory: 0 };
  const positiveInteger = (word, value) => {
    if (!/^[0-9]+$/.test(value) || Number(value) === 0) {
      throw new Error(`guest.start: "${word}" needs a positive whole number, not "${value}"`);
    }
    return Number(value);
  };
  settings(spec, 'guest.start', (word, value) => {
    if (word === 'program') result.program = value;
    else if (word === 'arg') result.args.push(value);
    else if (word === 'read') result.read.push(value);
    else if (word === 'write') result.write.push(value);
    else if (word === 'module') result.modules.push(value);
    else if (word === 'time') result.time = positiveInteger(word, value);
    else if (word === 'memory') result.memory = positiveInteger(word, value);
    else return false;
    return true;
  });
  if (result.program === null) throw new Error('guest.start: the spec has no "program" line');
  return result;
}

// spawn(spec, app, bounds) starts a worker running the spec's program, whose folders must lie within the
// parent's bounds, and returns it: post(message, transfer), terminate(), onMessage(f) and onError(f), f given
// the reason. The spec's modules are the parent's grants for them.
export function guestModule(spawn) {
  let caller = null;
  const alive = new Map();
  let nextNumber = 1;

  const deliver = (g, tag, kind, bytes) => {
    if (caller) caller.event(kind, g, tag, 0, bytes);
  };

  const end = (g, reason) => {
    const guest = alive.get(g);
    if (!guest) return;
    alive.delete(g);
    clearTimeout(guest.timer);
    guest.worker.terminate();
    caller.forget(g);
    if (reason !== null) deliver(g, guest.tag, ENDED, utf8.encode(reason));
  };

  // The time limit runs while the guest is busy: from its start, and from each call into it.
  const limit = (g, guest) => {
    clearTimeout(guest.timer);
    guest.timer = guest.time > 0 ? setTimeout(() => end(g, `time limit exceeded (${guest.time} ms)`), guest.time) : null;
  };

  function start(specText, tag, app) {
    const spec = parseSpec(specText);
    const grants = caller.grants();
    const modules = spec.modules.map((name) => {
      if (!floorModules.includes(name) || !grants.has(name)) throw new Error(`guest.start: no module ${name} to grant`);
      return grants.get(name);
    });
    if (!grants.has('fs')) throw new Error('guest.start: no files to grant');
    const fs = caller.module('fs');
    const worker = spawn({ ...spec, modules }, app, (fs && fs.bounds) || {});
    const g = nextNumber++;
    const guest = { worker, tag, time: spec.time, timer: null };
    alive.set(g, guest);
    worker.onMessage((m) => {
      if (alive.get(g) !== guest) return;
      if (m.type === 'output') deliver(g, tag, m.fd === 2 ? STDERR : STDOUT, m.bytes);
      else if (m.type === 'message') deliver(g, tag, MESSAGE, m.bytes);
      else if (m.type === 'done') deliver(g, tag, DONE, utf8.encode(m.trap));
      else if (m.type === 'busy') limit(g, guest);
      else if (m.type === 'idle') clearTimeout(guest.timer);
      else if (m.type === 'ended') end(g, m.reason);
    });
    worker.onError((reason) => end(g, reason));
    limit(g, guest);
    return g;
  }

  return (theCaller, app) => {
    caller = theCaller;
    return {
      source: SOURCE,
      end() {
        for (const g of [...alive.keys()]) end(g, null);
      },
      start(ptr, length, tag) {
        try {
          return start(caller.string(ptr, length), tag, app);
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
      },
      send(g, ptr, length) {
        const guest = alive.get(g);
        if (!guest) return -1;
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + length);
        guest.worker.post({ type: 'message', bytes }, [bytes.buffer]);
        return 0;
      },
      stop(g) {
        end(g, null);
      },
    };
  };
}
