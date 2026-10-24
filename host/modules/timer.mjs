// The host module "timer": timers, each firing once as an event.
const SOURCE = 5;
const FIRED = 1;

const most = 2147483647;

export function timer() {
  const pending = new Map();
  let next = 1;
  return (caller) => {
    return {
      source: SOURCE,
      end() {
        for (const t of pending.values()) clearTimeout(t.handle);
        pending.clear();
      },
      after(ms, tag) {
        const id = next++;
        const t = { handle: null };
        const step = (left) => {
          t.handle = setTimeout(() => {
            if (left > most) {
              step(left - most);
              return;
            }
            pending.delete(id);
            caller.event(FIRED, id, tag, 0);
          }, Math.min(left, most));
        };
        pending.set(id, t);
        step(ms);
        return id;
      },
      cancel(id) {
        const t = pending.get(id);
        if (!t) return;
        clearTimeout(t.handle);
        pending.delete(id);
        caller.forget(id);
      },
    };
  };
}
