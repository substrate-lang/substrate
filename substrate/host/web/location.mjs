// The host module "location" (location.sub).
import { errorOf } from '../errors.mjs';

const utf8 = new TextEncoder();

export function locationModule() {
  return (caller) => {
    const move = (go, ptr, len, err) => {
      try {
        go(caller.string(ptr, len));
        return 0;
      } catch (e) {
        caller.fail(err, e.message, errorOf(e));
        return -1;
      }
    };
    return {
      href: (out) => caller.give(utf8.encode(globalThis.location.href), out),
      assign: (ptr, len, err) => move((url) => globalThis.location.assign(url), ptr, len, err),
      replace: (ptr, len, err) => move((url) => globalThis.location.replace(url), ptr, len, err),
      reload() {
        globalThis.location.reload();
      },
    };
  };
}
