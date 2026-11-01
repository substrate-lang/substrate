// The globals a browser test controls: time from its clock, and seeded random bytes.
export function installClock(g, clock) {
  const RealDate = Date;
  class SimulatedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.epoch + Math.floor(clock.now()));
      else super(...args);
    }

    static now() {
      return clock.epoch + Math.floor(clock.now());
    }
  }
  Object.assign(g, {
    Date: SimulatedDate,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
  });
  Object.defineProperty(g, 'performance', { value: { now: () => clock.now(), timeOrigin: clock.epoch }, configurable: true, writable: true });
}

// seeded gives a function that fills bytes with the same numbers for the same seed.
export function seeded(seed) {
  let state = (seed >>> 0) || 1;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[i] = state & 0xff;
    }
  };
}

export function installRandom(g, seed) {
  const fill = seeded(seed);
  Object.defineProperty(g, 'crypto', {
    value: {
      getRandomValues(a) {
        fill(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
        return a;
      },
    },
    configurable: true,
    writable: true,
  });
}
