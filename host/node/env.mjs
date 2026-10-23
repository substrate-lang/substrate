// The host module "env": the environment's variables.
const utf8 = new TextEncoder();

export function env() {
  return (caller) => ({
    get(ptr, len, out) {
      const value = process.env[caller.string(ptr, len)];
      return value === undefined ? 0 : caller.give(utf8.encode(value), out);
    },
  });
}
