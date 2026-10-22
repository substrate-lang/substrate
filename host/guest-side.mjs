// A guest's side of the guest module, shared by the browser's worker and Node's thread: its output in
// batches, the parent's messages as events, when it is busy, and what it reports back.
const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;

// Output goes at most every 30 ms, and when the guest becomes idle.
function batcher(post) {
  const pieces = [];
  let pendingBytes = 0;
  let droppedBytes = 0;
  let lastSend = 0;
  let timer = null;
  const maxPending = 1 << 20;

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
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
    const since = performance.now() - lastSend;
    if (since >= 30) flush();
    else if (timer === null) timer = setTimeout(flush, 30 - since);
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
    active(busy) {
      if (ended) return;
      if (!busy) out.flush();
      post({ type: busy ? 'busy' : 'idle' });
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
