// The host module "clock": the time of day, and a clock that never goes back.
export function clock() {
  return () => {
    const started = performance.now();
    return {
      now: () => Date.now(),
      monotonic: () => performance.now() - started,
    };
  };
}
