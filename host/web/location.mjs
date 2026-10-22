// The host module "location": the page's URL, and the history it moves through.
// Kinds: changed 1, bytes the URL, after the user goes back or forward; untagged.
const utf8 = new TextEncoder();

const SOURCE = 12;
const CHANGED = 1;

export function locationModule() {
  return (caller) => {
    const popped = () => caller.event(CHANGED, 0, 0, 0, utf8.encode(globalThis.location.href));
    addEventListener('popstate', popped);
    const move = (go, ptr, len) => {
      try {
        go(caller.string(ptr, len));
        return 0;
      } catch (e) {
        caller.error(e.message);
        return -1;
      }
    };
    return {
      source: SOURCE,
      end() {
        removeEventListener('popstate', popped);
      },
      get(buf, cap) {
        const bytes = utf8.encode(globalThis.location.href);
        caller.memory().set(bytes.subarray(0, cap), caller.u(buf));
        return bytes.length;
      },
      push: (ptr, len) => move((url) => history.pushState(null, '', url), ptr, len),
      replace: (ptr, len) => move((url) => history.replaceState(null, '', url), ptr, len),
      back() {
        history.back();
      },
    };
  };
}
