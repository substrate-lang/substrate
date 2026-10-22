// A guest's side of the guest module, shared by the browser's worker and Node's thread: its output in
// batches, the parent's messages as events, and what it reports back.
const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;

export const isUnder = (dir, path) => path === dir || path.startsWith(dir === '/' ? dir : `${dir}/`);

const floor = {
  clock: () => import('./modules/clock.mjs').then((m) => m.clock()),
  random: () => import('./modules/random.mjs').then((m) => m.random()),
  timer: () => import('./modules/timer.mjs').then((m) => m.timer()),
  fetch: () => import('./modules/fetch.mjs').then((m) => m.fetchModule()),
  websocket: () => import('./modules/websocket.mjs').then((m) => m.websocket()),
};

function batcher(post) {
  const pieces = [];
  let pendingBytes = 0;
  let droppedBytes = 0;
  let lastSend = 0;
  const maxPending = 1 << 20;

  function flush() {
    lastSend = performance.now();
    if (droppedBytes > 0) {
      pieces.push([2, utf8.encode(`\n... ${droppedBytes} bytes of output dropped\n`)]);
      droppedBytes = 0;
    }
    for (let i = 0; i < pieces.length; ) {
      const fd = pieces[i][0];
      let j = i;
      let length = 0;
      for (; j < pieces.length && pieces[j][0] === fd; j++) length += pieces[j][1].length;
      const bytes = new Uint8Array(length);
      for (let at = 0; i < j; i++) {
        bytes.set(pieces[i][1], at);
        at += pieces[i][1].length;
      }
      post({ type: 'output', fd, bytes }, [bytes.buffer]);
    }
    pieces.length = 0;
    pendingBytes = 0;
  }

  function output(fd, bytes) {
    if (pendingBytes + bytes.length > maxPending) droppedBytes += bytes.length;
    else {
      pieces.push([fd, bytes.slice()]);
      pendingBytes += bytes.length;
    }
    if (performance.now() - lastSend >= 30) flush();
  }

  return { output, flush };
}

// post(message, transfer) sends to the parent.
export function guestSide(post) {
  const out = batcher(post);
  let host = null;
  let ended = false;
  const waiting = [];

  const guest = (caller) => ({
    source: SOURCE,
    start() {
      caller.error('guest.start: a guest cannot start guests of its own');
      return 0;
    },
    send(g, ptr, length) {
      if (g !== 0) return -1;
      out.flush();
      const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + length);
      post({ type: 'message', bytes }, [bytes.buffer]);
      return 0;
    },
    stop() {},
  });

  function done(result) {
    out.flush();
    if (!ended) post({ type: 'done', trap: result === false ? host.lastError : '' });
  }

  return {
    guest,
    write: out.output,
    report(message) {
      out.output(2, utf8.encode(`error: ${message}\n`));
    },
    ended(reason) {
      ended = true;
      out.flush();
      post({ type: 'ended', reason });
    },
    delivered(event, ok) {
      if (event.source === SOURCE && event.id === 0) done(ok);
    },
    async modules(names) {
      const made = {};
      for (const name of names) made[name] = await floor[name]();
      return made;
    },
    started(theHost, result) {
      host = theHost;
      done(result);
      for (const bytes of waiting.splice(0)) host.event(SOURCE, MESSAGE, 0, 0, 0, bytes);
    },
    message(bytes) {
      if (ended) return;
      if (host) host.event(SOURCE, MESSAGE, 0, 0, 0, bytes);
      else waiting.push(bytes);
    },
  };
}
