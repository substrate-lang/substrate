// Lifecycle: experimental.
//
// The script that runs inside a guest's Web Worker. guest.mjs creates
// one worker per guest and explains what a guest is.
//
// The worker is a complete host for one program, like a page's
// (subhost-web.mjs), with these differences:
//   - there is no page: the only host module the program gets is "guest";
//   - its files are an in-memory copy of what the starting program
//     granted;
//   - what the program writes to standard output and standard error is
//     sent to the page instead of the console.
//
// Messages from the page to this worker:
//
//   { type: 'start', names, linklets, files, args, cwd, writable, memory }
//       Sent once, first. Loads and starts the guest's program.
//         names, linklets  the program: the names of its wasm modules, in
//                          load order, and a Map from name to bytes
//         files            a Map from path to bytes: the files it can read
//         args             its command-line arguments
//         cwd              the directory relative paths start from
//         writable         the directories it may write files under
//         memory           the limit for each wasm memory, in mebibytes,
//                          or 0 for no limit
//   { type: 'message', bytes }
//       A message for the program. The worker calls the program's
//       on-message function.
//
// Messages from this worker to the page:
//
//   { type: 'output', fd, bytes }   the program wrote `bytes` to standard
//                                   output (fd 1) or standard error (fd 2)
//   { type: 'message', bytes }      the program sent a message
//   { type: 'done', trap }          the program finished its start-up or
//                                   one message. `trap` is '' normally,
//                                   or the trap's message if that work
//                                   ended in a trap.
//   { type: 'ended', reason }       the program exited; nothing more will
//                                   come from this worker
import { run } from './subhost-web.mjs';

// The running program, once started.
let app = null;
// The message being handled by on-message, so that `take` can read it.
let currentMessage = null;

// ---- Batching the program's output ----
//
// A program may write a few bytes at a time. Posting one message to the
// page for every write would be very slow, so writes are collected in
// `pieces` and sent together. They are sent:
//   - when 30 ms have passed since the last send, so the user still sees
//     output while a long computation runs;
//   - just before the program sends a message of its own, so the page
//     receives output and messages in the order they were produced;
//   - when the program finishes a piece of work.
//
// A program that prints in an endless loop must not be able to flood the
// page. At most `maxPending` bytes are kept between two sends; anything
// beyond that is dropped, and a note saying how much is added.
const pieces = []; // each is [fd, bytes]
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
  // Consecutive pieces for the same fd are joined into one message.
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

// Called by the host for each write to standard output or error.
function output(fd, bytes) {
  if (pendingBytes + bytes.length > maxPending) droppedBytes += bytes.length;
  else {
    // `bytes` points into the program's memory, which will change, so
    // keep a copy.
    pieces.push([fd, bytes.slice()]);
    pendingBytes += bytes.length;
  }
  if (performance.now() - lastSend >= 30) sendOutput();
}

// The host module "guest" as a guest sees it. Guest number 0 is the
// program that started this guest; there are no other guests.
const guest = (caller) => ({
  start() {
    caller.error('guest.start: a guest cannot start guests of its own');
    return 0;
  },
  send(g, ptr, length) {
    if (g !== 0) return -1;
    sendOutput();
    const bytes = caller.memory().slice(ptr, ptr + length);
    self.postMessage({ type: 'message', bytes }, [bytes.buffer]);
    return 0;
  },
  take(buf, cap) {
    if (!currentMessage) return 0;
    caller.memory().set(currentMessage.subarray(0, cap), buf);
    return currentMessage.length;
  },
  stop() {},
});

// Tells the page that the program finished a piece of work. `result` is
// what app.call returned: false means the work ended in a trap.
function reportDone(result) {
  sendOutput();
  if (!app.ended) self.postMessage({ type: 'done', trap: result === false ? app.host.lastError : '' });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    const isUnder = (dir, path) => path === dir || path.startsWith(dir === '/' ? dir : `${dir}/`);
    // run() loads the program and calls its main.
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
