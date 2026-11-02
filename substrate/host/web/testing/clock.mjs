// The clock of a browser in browser tests. Time moves only when a test advances it, and timers, animation frames at 60
// a second, Date and performance all follow it.
export function makeClock(epoch = 1700000000000) {
  let now = 0;
  let next = 1;
  let frame = 0;
  const timers = new Map();
  const frames = new Map();

  const add = (f, ms, args, every) => {
    const id = next++;
    timers.set(id, { id, due: now + Math.max(0, Number(ms) || 0), f, args, every, order: id });
    return id;
  };
  const earliest = () => {
    let first = null;
    for (const t of timers.values()) if (first === null || t.due < first.due || (t.due === first.due && t.order < first.order)) first = t;
    return first;
  };
  const fire = (t) => {
    if (t.every === null) timers.delete(t.id);
    else {
      t.due += t.every;
      t.order = next++;
    }
    t.f(...t.args);
  };
  const nextFrame = () => ((Math.floor((now * 60) / 1000 + 1e-9) + 1) * 1000) / 60;

  return {
    epoch,
    now: () => now,
    setTimeout: (f, ms, ...args) => add(f, ms, args, null),
    setInterval: (f, ms, ...args) => add(f, ms, args, Math.max(1, Number(ms) || 0)),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame(f) {
      const id = next++;
      frames.set(id, f);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    dueNow() {
      const t = earliest();
      if (t === null || t.due > now) return false;
      fire(t);
      return true;
    },
    // advance moves the clock ms ahead, running the timers and frames due on the way in time order and settling the
    // program after each.
    async advance(ms, settle) {
      const end = now + Math.max(0, ms);
      for (;;) {
        const t = earliest();
        const f = frames.size > 0 ? nextFrame() : Infinity;
        const at = Math.min(t === null ? Infinity : t.due, f);
        if (at > end) break;
        now = at;
        if (t !== null && t.due <= f) fire(t);
        else {
          frame++;
          const due = [...frames.values()];
          frames.clear();
          for (const callback of due) callback(now);
        }
        await settle();
      }
      now = end;
    },
    frames: () => frame,
  };
}
