// The globals a simulated page and its workers share: time from the simulated clock, and seeded random bytes.
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

export function installRandom(g, seed) {
  let state = (seed >>> 0) || 1;
  const nextByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 0xff;
  };
  Object.defineProperty(g, 'crypto', {
    value: {
      getRandomValues(a) {
        const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        for (let i = 0; i < bytes.length; i++) bytes[i] = nextByte();
        return a;
      },
    },
    configurable: true,
    writable: true,
  });
}
