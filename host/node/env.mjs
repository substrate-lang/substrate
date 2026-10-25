// The host module "env" (env.sub).
import { mayEnv } from '../grants.mjs';

const utf8 = new TextEncoder();

export function env(grants) {
  return (caller) => {
    const named = (call, ptr, len, err) => {
      const name = caller.string(ptr, len);
      if (name === '' || /[=\0]/.test(name)) {
        caller.fail(err, `${call}: a variable's name cannot be empty or hold = or NUL`);
        return null;
      }
      if (!mayEnv(grants.env, name)) {
        caller.fail(err, `${call}: ${name} is not granted (--allow-env)`);
        return null;
      }
      return name;
    };
    return {
      get(ptr, len, out, err) {
        const name = named('env.get', ptr, len, err);
        const value = name === null ? undefined : process.env[name];
        return value === undefined ? 0 : caller.give(utf8.encode(value), out);
      },
      set(np, nl, vp, vl, err) {
        const name = named('env.set', np, nl, err);
        if (name === null) return -1;
        const value = caller.string(vp, vl);
        if (value.includes('\0')) {
          caller.fail(err, "env.set: a variable's value cannot hold NUL");
          return -1;
        }
        process.env[name] = value;
        return 0;
      },
      delete(ptr, len, err) {
        const name = named('env.delete', ptr, len, err);
        if (name === null) return -1;
        delete process.env[name];
        return 0;
      },
    };
  };
}
