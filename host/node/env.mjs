// The host module "env" (env.sub).
import { mayEnv } from '../grants.mjs';

const utf8 = new TextEncoder();

export function env(grants) {
  return (caller) => ({
    get(ptr, len, out, err) {
      const name = caller.string(ptr, len);
      if (!mayEnv(grants.env, name)) {
        caller.fail(err, `env.get: ${name} is not granted (--allow-env)`);
        return 0;
      }
      const value = process.env[name];
      return value === undefined ? 0 : caller.give(utf8.encode(value), out);
    },
  });
}
