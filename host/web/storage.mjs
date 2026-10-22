// The host module "storage": keys and their bytes, kept by the browser in IndexedDB.
// Kinds: got 1, value 1 if the key was found, bytes its value; done 2; keys 3, value how many, bytes the keys,
// one per line; failed 4, value the error code.
import { errorOf } from '../errors.mjs';

const utf8 = new TextEncoder();

const SOURCE = 11;
const GOT = 1;
const DONE = 2;
const KEYS = 3;
const FAILED = 4;

export function storage(name = 'substrate') {
  const opened = new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  opened.catch(() => {});
  return (caller) => {
    let next = 1;
    let ended = false;
    const run = (tag, mode, ask, answer) => {
      const id = next++;
      opened.then((db) => new Promise((resolve, reject) => {
        const request = ask(db.transaction('keys', mode).objectStore('keys'));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })).then((result) => {
        if (!ended) answer(id, result);
      }, (e) => {
        if (!ended) caller.event(FAILED, id, tag, errorOf(e), utf8.encode(e.message));
      });
      return id;
    };
    return {
      source: SOURCE,
      end() {
        ended = true;
      },
      get(kp, kl, tag) {
        const key = caller.string(kp, kl);
        return run(tag, 'readonly', (s) => s.get(key), (id, value) => {
          caller.event(GOT, id, tag, value === undefined ? 0 : 1, value === undefined ? new Uint8Array(0) : value);
        });
      },
      set(kp, kl, ptr, len, tag) {
        const key = caller.string(kp, kl);
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
        return run(tag, 'readwrite', (s) => s.put(bytes, key), (id) => caller.event(DONE, id, tag, 0));
      },
      remove(kp, kl, tag) {
        const key = caller.string(kp, kl);
        return run(tag, 'readwrite', (s) => s.delete(key), (id) => caller.event(DONE, id, tag, 0));
      },
      list(pp, pl, tag) {
        const prefix = caller.string(pp, pl);
        const ask = (s) => (prefix === '' ? s.getAllKeys() : s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
        return run(tag, 'readonly', ask, (id, keys) => {
          caller.event(KEYS, id, tag, keys.length, utf8.encode(keys.map((k) => `${k}\n`).join('')));
        });
      },
    };
  };
}
