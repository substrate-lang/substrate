// The host module "guest": runs another program in a worker, sharing nothing but messages. The
// browser and Node each give it their way of starting a worker.
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
  for (const line of spec.split('\n')) {
    if (line.trim() === '') continue;
    const space = line.indexOf(' ');
    const word = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (word === 'program') result.program = value;
    else if (word === 'arg') result.args.push(value);
    else if (word === 'read') result.read.push(value);
    else if (word === 'write') result.write.push(value);
    else if (word === 'module') result.modules.push(value);
    else if (word === 'time') result.time = positiveInteger(word, value);
    else if (word === 'memory') result.memory = positiveInteger(word, value);
    else throw new Error(`guest.start: unknown setting "${word}" in the spec`);
  }
  if (result.program === null) throw new Error('guest.start: the spec has no "program" line');
  return result;
}

// spawn(spec, app) starts a worker running the spec's program and returns it: post(message, transfer),
// terminate(), onMessage(f) and onError(f), f given the reason.
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

  const restartTimer = (g, guest) => {
    clearTimeout(guest.timer);
    guest.timer = guest.time > 0 && guest.unfinished > 0
      ? setTimeout(() => end(g, `time limit exceeded (${guest.time} ms)`), guest.time)
      : null;
  };

  function start(specText, tag, app) {
    const spec = parseSpec(specText);
    const granted = caller.modules();
    for (const name of spec.modules) {
      if (!floorModules.includes(name) || !granted.includes(name)) throw new Error(`guest.start: no module ${name} to grant`);
    }
    const worker = spawn(spec, app);
    const g = nextNumber++;
    const guest = { worker, tag, time: spec.time, unfinished: 1, timer: null };
    alive.set(g, guest);
    worker.onMessage((m) => {
      if (alive.get(g) !== guest) return;
      if (m.type === 'output') deliver(g, tag, m.fd === 2 ? STDERR : STDOUT, m.bytes);
      else if (m.type === 'message') deliver(g, tag, MESSAGE, m.bytes);
      else if (m.type === 'done') {
        guest.unfinished--;
        restartTimer(g, guest);
        deliver(g, tag, DONE, utf8.encode(m.trap));
      } else if (m.type === 'ended') end(g, m.reason);
    });
    worker.onError((reason) => end(g, reason));
    restartTimer(g, guest);
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
        if (guest.unfinished++ === 0) restartTimer(g, guest);
        return 0;
      },
      stop(g) {
        end(g, null);
      },
    };
  };
}
