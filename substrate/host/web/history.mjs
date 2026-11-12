// The host module "history" (history.sub).
import { errorOf } from '../errors.mjs';

const utf8 = new TextEncoder();

const SOURCE = 12;
const POPSTATE = 1;

export function historyModule() {
  return (caller) => {
    const listeners = new Map();
    let next = 1;
    const popped = () => {
      const url = utf8.encode(globalThis.location.href);
      for (const [id, tag] of listeners) caller.event(POPSTATE, id, tag, 0, url);
    };
    addEventListener('popstate', popped);
    const change = (method, sp, sl, up, ul, err) => {
      try {
        const state = sl === 0 ? null : caller.memory().slice(caller.u(sp), caller.u(sp) + sl);
        const url = caller.string(up, ul);
        if (url === '') history[method](state, '');
        else history[method](state, '', url);
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
      push_state: (sp, sl, up, ul, err) => change('pushState', sp, sl, up, ul, err),
      replace_state: (sp, sl, up, ul, err) => change('replaceState', sp, sl, up, ul, err),
      state(out) {
        const s = history.state;
        if (s instanceof Uint8Array && s.length > 0) return caller.give(s, out);
        new DataView(caller.memory().buffer).setUint32(caller.u(out), 0, true);
        return 0;
      },
      back() {
        history.back();
      },
      forward() {
        history.forward();
      },
      go(delta) {
        history.go(delta);
      },
      scroll_restoration: () => (history.scrollRestoration === 'manual' ? 1 : 0),
      set_scroll_restoration(ptr, len) {
        history.scrollRestoration = caller.string(ptr, len);
      },
      listen(tag) {
        const id = next++;
        listeners.set(id, tag);
        return id;
      },
      unlisten(id) {
        listeners.delete(id);
        caller.forget(id);
      },
    };
  };
}
