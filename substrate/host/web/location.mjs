// The host module "location" (location.sub).
import { errorOf } from '../errors.mjs';

const utf8 = new TextEncoder();

const SOURCE = 12;
const CHANGED = 1;

export function locationModule() {
  return (caller) => {
    const popped = () => caller.event(CHANGED, 0, 0, 0, utf8.encode(globalThis.location.href));
    addEventListener('popstate', popped);
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
      source: SOURCE,
      end() {
        removeEventListener('popstate', popped);
      },
      get: (out) => caller.give(utf8.encode(globalThis.location.href), out),
      push: (ptr, len, err) => move((url) => history.pushState(null, '', url), ptr, len, err),
      replace: (ptr, len, err) => move((url) => history.replaceState(null, '', url), ptr, len, err),
      back() {
        history.back();
      },
    };
  };
}
