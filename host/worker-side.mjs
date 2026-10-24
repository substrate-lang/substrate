// The worker module's side inside a worker, in a browser or on Node. It batches output, delivers the parent's
// messages as events, and reports back.
const utf8 = new TextEncoder();

const SOURCE = 3;
const MESSAGE = 1;

// Output is sent at most every 30 ms and when the worker becomes idle. Output heard as events is dropped while
// 1 MiB of it waits.
function batcher(post) {
  const pieces = [];
  let pendingBytes = 0;
  let droppedBytes = 0;
  let lastSend = 0;
  let timer = null;
  let limited = false;
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
    if (limited && pendingBytes + bytes.length > maxPending) droppedBytes += bytes.length;
    else {
      pieces.push([fd, bytes.slice()]);
      pendingBytes += bytes.length;
    }
    const since = performance.now() - lastSend;
    if (since >= 30) flush();
    else if (timer === null) timer = setTimeout(flush, 30 - since);
  }

  return {
    output,
    flush,
    limit() {
      limited = true;
    },
  };
}

// post(message, transfer) sends to the parent.
export function workerSide(post) {
  const out = batcher(post);
  let host = null;
  let ended = false;
  const waiting = [];

  const worker = (caller) => ({
    source: SOURCE,
    start(np, nl, bp, bl, time, size, heard, tag, err) {
      caller.fail(err, 'worker.start: a worker cannot start workers');
      return 0;
    },
    send(w, ptr, length) {
      if (w !== 0) return -1;
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
    worker,
    write: out.output,
    limitOutput: out.limit,
    report(message) {
      out.output(2, utf8.encode(`error: ${message}\n`));
    },
    ended(code, reason) {
      ended = true;
      out.flush();
      post({ type: 'ended', code, reason });
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
