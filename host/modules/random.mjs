// The host module "random": cryptographically strong random bytes.
export function random() {
  return (caller) => ({
    fill(ptr, len) {
      const memory = caller.memory();
      const at = caller.u(ptr);
      for (let done = 0; done < len; done += 65536) {
        crypto.getRandomValues(memory.subarray(at + done, at + Math.min(len, done + 65536)));
      }
    },
  });
}
