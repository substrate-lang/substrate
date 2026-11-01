// The simulated browser's IndexedDB: as much as substrate/host/web/storage.mjs uses. The databases last for the
// browser's life, so a page reloaded finds what it stored.
export function makeIndexedDB(databases, later) {
  const request = (work) => {
    const r = { result: undefined, error: null, onsuccess: null, onerror: null };
    later(() => {
      try {
        r.result = work();
      } catch (e) {
        r.error = e;
        if (r.onerror) r.onerror({ target: r });
        return;
      }
      if (r.onsuccess) r.onsuccess({ target: r });
    });
    return r;
  };
  const copy = (v) => (ArrayBuffer.isView(v) ? v.slice() : structuredClone(v));
  const storeOf = (db, name) => {
    const data = db.get(name);
    if (!data) throw new Error(`NotFoundError: there is no object store ${name}`);
    return {
      get: (key) => request(() => (data.has(key) ? copy(data.get(key)) : undefined)),
      put: (value, key) => request(() => {
        data.set(key, copy(value));
        return key;
      }),
      delete: (key) => request(() => {
        data.delete(key);
      }),
      getAllKeys: (range) => request(() => [...data.keys()].filter((k) => !range || range.includes(k)).sort()),
    };
  };
  const indexedDB = {
    open(name) {
      const r = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        let db = databases.get(name);
        const fresh = db === undefined;
        if (fresh) {
          db = new Map();
          databases.set(name, db);
        }
        r.result = {
          createObjectStore(store) {
            if (!db.has(store)) db.set(store, new Map());
            return storeOf(db, store);
          },
          transaction: () => ({ objectStore: (store) => storeOf(db, store) }),
          close() {},
        };
        if (fresh && r.onupgradeneeded) r.onupgradeneeded({ target: r });
        if (r.onsuccess) r.onsuccess({ target: r });
      });
      return r;
    },
  };
  const IDBKeyRange = { bound: (lower, upper) => ({ includes: (k) => k >= lower && k <= upper }) };
  return { indexedDB, IDBKeyRange };
}
