// The host module "env": the environment's variables.
const utf8 = new TextEncoder();

export function env() {
  return (caller) => ({
    get(ptr, len, buf, cap) {
      const value = process.env[caller.string(ptr, len)];
      if (value === undefined) return -1;
      const bytes = utf8.encode(value);
      caller.memory().set(bytes.subarray(0, cap), caller.u(buf));
      return bytes.length;
    },
  });
}
