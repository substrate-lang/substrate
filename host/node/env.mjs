// The host module "env": the environment's variables.
const utf8 = new TextEncoder();

export function env() {
  return (caller) => ({
    get(ptr, len) {
      const value = process.env[caller.string(ptr, len)];
      return value === undefined ? -1 : caller.hold(utf8.encode(value));
    },
  });
}
