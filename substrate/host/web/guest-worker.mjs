// A guest's Web Worker: runs one program, its output sent to the page in batches.
import { run } from './subhost-web.mjs';

let app = null;
let currentMessage = null;

// Output is sent every 30 ms, before a message and when a piece of work ends, and at most
// maxPending bytes between sends, so that a program printing in a loop cannot flood the page.
const pieces = [];
let pendingBytes = 0;
let droppedBytes = 0;
let lastSend = 0;
const maxPending = 1 << 20;

function sendOutput() {
  lastSend = performance.now();
  if (droppedBytes > 0) {
    pieces.push([2, new TextEncoder().encode(`\n... ${droppedBytes} bytes of output dropped\n`)]);
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
    self.postMessage({ type: 'output', fd, bytes }, [bytes.buffer]);
  }
  pieces.length = 0;
  pendingBytes = 0;
}

function output(fd, bytes) {
  if (pendingBytes + bytes.length > maxPending) droppedBytes += bytes.length;
  else {
    // bytes points into the program's memory, which will change: keep a copy.
    pieces.push([fd, bytes.slice()]);
    pendingBytes += bytes.length;
  }
  if (performance.now() - lastSend >= 30) sendOutput();
}

const guest = (caller) => ({
  start() {
    caller.error('guest.start: a guest cannot start guests of its own');
    return 0;
  },
  send(g, ptr, length) {
    if (g !== 0) return -1;
    sendOutput();
    const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + length);
    self.postMessage({ type: 'message', bytes }, [bytes.buffer]);
    return 0;
  },
  take(buf, cap) {
    if (!currentMessage) return 0;
    caller.memory().set(currentMessage.subarray(0, cap), caller.u(buf));
    return currentMessage.length;
  },
  stop() {},
});

function reportDone(result) {
  sendOutput();
  if (!app.ended) self.postMessage({ type: 'done', trap: result === false ? app.host.lastError : '' });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    const isUnder = (dir, path) => path === dir || path.startsWith(dir === '/' ? dir : `${dir}/`);
    app = run({
      args: m.args,
      files: m.files,
      cwd: m.cwd,
      output,
      mayWrite: (path) => m.writable.some((dir) => isUnder(dir, path)),
      // A wasm page is 64 KiB, so there are 16 pages in a mebibyte.
      memoryPages: m.memory * 16,
      modules: { guest },
      onExit(code) {
        sendOutput();
        self.postMessage({ type: 'ended', reason: `exit ${code}` });
      },
    }, m.names, m.linklets);
    reportDone(app.started);
  } else if (m.type === 'message' && app && !app.ended) {
    currentMessage = m.bytes;
    const result = app.call('on-message');
    currentMessage = null;
    reportDone(result);
  }
};
