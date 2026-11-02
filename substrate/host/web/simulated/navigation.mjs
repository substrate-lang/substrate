// The simulated browser's location and history. History entries last as long as the browser, so reloading or going
// to another URL keeps them.
export function makeHistory(url) {
  const entries = [url];
  let index = 0;
  return {
    current: () => new URL(entries[index]),
    push(href) {
      entries.splice(index + 1);
      entries.push(href);
      index = entries.length - 1;
    },
    replace(href) {
      entries[index] = href;
    },
    go(n) {
      const k = index + n;
      if (k < 0 || k >= entries.length) return false;
      index = k;
      return true;
    },
    get length() {
      return entries.length;
    },
  };
}

export function locationOf(history) {
  const location = { toString: () => history.current().href };
  for (const name of ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
    Object.defineProperty(location, name, { get: () => history.current()[name], enumerable: true });
  }
  return location;
}

// popped is called when back, forward or go moves to another entry, where a browser sends popstate.
export function historyOf(history, popped) {
  const resolved = (url) => {
    const here = history.current();
    if (url === undefined || url === null) return here.href;
    const next = new URL(url, here);
    if (next.origin !== here.origin) throw new Error(`SecurityError: a history entry cannot be at ${next.origin}, not ${here.origin}`);
    return next.href;
  };
  return {
    state: null,
    get length() {
      return history.length;
    },
    pushState(state, title, url) {
      history.push(resolved(url));
      this.state = state;
    },
    replaceState(state, title, url) {
      history.replace(resolved(url));
      this.state = state;
    },
    back() {
      this.go(-1);
    },
    forward() {
      this.go(1);
    },
    go(n = 0) {
      if (n !== 0 && history.go(n)) popped();
    },
  };
}
