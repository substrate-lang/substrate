// The host module "signal" (signal.sub) on Node.
import os from 'node:os';

const SOURCE = 16;
const RECEIVED = 1;

const forbidden = new Set(['SIGKILL', 'SIGSTOP', 'SIGILL', 'SIGFPE', 'SIGSEGV']);

export function signals() {
  const listeners = new Map();
  let next = 1;
  return (caller) => ({
    source: SOURCE,
    end() {
      for (const l of listeners.values()) process.off(l.name, l.heard);
      listeners.clear();
    },
    listen(np, nl, tag, err) {
      const name = caller.string(np, nl);
      if (!Object.hasOwn(os.constants.signals, name)) {
        caller.fail(err, `signal.listen: ${name} is not a signal`);
        return 0;
      }
      if (forbidden.has(name)) {
        caller.fail(err, `signal.listen: ${name} cannot be listened for`);
        return 0;
      }
      const id = next++;
      const l = { name, heard: () => caller.event(RECEIVED, id, tag, 0) };
      process.on(name, l.heard);
      listeners.set(id, l);
      return id;
    },
    stop(id) {
      const l = listeners.get(id);
      if (!l) return;
      listeners.delete(id);
      process.off(l.name, l.heard);
      caller.forget(id);
    },
  });
}
