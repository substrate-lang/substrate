// The host module "timer": timers, each firing once as an event.
const SOURCE = 5;
const FIRED = 1;

export function timer() {
  return (caller) => {
    const pending = new Map();
    let next = 1;
    return {
      source: SOURCE,
      after(ms) {
        const id = next++;
        pending.set(id, setTimeout(() => {
          pending.delete(id);
          caller.event(FIRED, id, 0);
        }, ms));
        return id;
      },
      cancel(id) {
        const t = pending.get(id);
        if (t === undefined) return;
        clearTimeout(t);
        pending.delete(id);
      },
    };
  };
}
