// Lifecycle: experimental.
//
// The host module "guest", for the browser: lets a program run another
// program in a sandbox.
//
// A "guest" is a second program, started by the first, that runs
// completely separately from it. The guest has its own memory and its own
// wasm instances; the two programs share nothing. They talk only by
// sending each other messages, which are byte strings that the host
// copies across. This makes a guest a safe place to run untrusted code:
//
//   - The guest cannot read or write the first program's memory.
//   - If the guest crashes, only the guest is affected.
//   - If the guest loops forever, the first program can still end it.
//   - The guest can only use what the first program granted it (below).
//
// In the browser each guest is a Web Worker (guest-worker.mjs), so it
// runs on its own thread and the page stays responsive while it works.
// The interface does not depend on workers: a program only sends
// messages and receives events later, which a single-threaded host could
// also provide. So far only this browser host implements the module.
//
// Usage, in the page:
//
//   import { guests } from './guest.mjs';
//   boot({ ..., modules: { guest: guests() } })
//
// lib/web/guest.sub wraps the module for programs written in the C-like
// Lisp.
//
// ---- What a program can call ----
//
// All pointers are addresses in the calling program's memory.
//
//   start (spec, len) -> i32
//       Starts a guest. `spec` is text, described below. Returns the
//       guest's number (1 or more). Returns 0 if the guest could not be
//       started; host.error_message then gives the reason.
//   send (guest, ptr, len) -> i32
//       Sends the guest a message: a copy of `len` bytes. Returns 0, or
//       -1 if there is no such guest (for example, it has ended).
//   take (buf, cap) -> len
//       Only meaningful while the program's on-guest function is running
//       (see below). Copies the event's data to `buf`, at most `cap`
//       bytes, and returns the data's full length. Call it with cap 0 to
//       learn the length first.
//   stop (guest)
//       Ends the guest immediately, whatever it is doing. No further
//       events arrive from it.
//
// ---- What a program is told ----
//
// The host calls the program's exported function `on-guest (guest, kind)`
// each time something happens in a guest. `kind` is a number:
//
//   1  message   The guest sent a message. The data is the message.
//   2  stdout    The guest wrote to its standard output. The data is
//                what it wrote. Output is delivered while the guest is
//                still running, in pieces.
//   3  stderr    The same, for standard error. If the guest traps
//                (crashes) and has no on-trap function of its own, the
//                trap report is written here.
//   4  done      The guest finished one piece of work: either its
//                start-up (its `main` function) or the handling of one
//                message. The data is empty, or, if that work ended in a
//                trap, the trap's message. A "done" arrives for every
//                piece of work, in order, whether or not the guest sent
//                anything, so a program can use it to notice a guest that
//                failed without replying.
//   5  ended     The guest is gone and its number is no longer valid. The
//                data is the reason, as text:
//                  "exit N"        the guest's program exited with status
//                                  N (2 if it could not even be loaded)
//                  "time limit..." it ran longer than its `time` allowed
//                  "error: ..."    the worker itself failed
//                This event is not sent for a guest ended with `stop`.
//
// ---- The spec ----
//
// `spec` says which program to run and what it may use. It is text, one
// setting per line: a word, a space, then the value. Paths are resolved
// like any other path the program uses.
//
//   program DIR   Required. The guest's program: a directory written by
//                 `sub build`.
//   arg TEXT      One command-line argument for the guest. Repeat the
//                 line for more arguments.
//   read DIR      The guest may read the files under DIR. It gets a copy
//                 of them, made when it starts. Without any `read` line
//                 the guest can read no files.
//   write DIR     The guest may create and overwrite files under DIR.
//                 These writes only change the guest's own copy; the
//                 first program's files never change.
//   time MS       A time limit, in milliseconds, for the guest's start-up
//                 and for each message it handles. A guest that takes
//                 longer is ended.
//   memory MB     A size limit, in mebibytes, for each wasm linear memory
//                 of the guest. Growing a memory past the limit fails, as
//                 if the machine were out of memory. It does not limit
//                 wasm GC objects, which live in the browser's own heap.
//
// Example: "program /worker\nread /data\ntime 500\nmemory 64"
//
// ---- What a guest is ----
//
// A guest is an ordinary program. The host calls its `main` when it
// starts. After that, for each message it is sent, the host calls its
// exported function `on-message` (no arguments); during that call `take`
// gives the message. To send a message back, the guest calls `send` with
// guest number 0, which always means "the program that started me".
//
// A guest gets the standard host functions (spec section 4), but they
// only reach its own instances and the files it was granted. The only
// host module it gets is this one, and in a guest `start` always fails:
// a guest cannot start guests of its own.
import { resolvePath } from './subhost-web.mjs';

const text = new TextDecoder();
const utf8 = new TextEncoder();

// The event kinds, as passed to on-guest.
const MESSAGE = 1;
const STDOUT = 2;
const STDERR = 3;
const DONE = 4;
const ENDED = 5;

// Parses a spec. Returns { program, args, read, write, time, memory }, or
// throws an Error that describes the problem.
function parseSpec(spec) {
  const result = { program: null, args: [], read: [], write: [], time: 0, memory: 0 };
  const positiveInteger = (word, value) => {
    if (!/^[0-9]+$/.test(value) || Number(value) === 0) {
      throw new Error(`guest.start: "${word}" needs a positive whole number, not "${value}"`);
    }
    return Number(value);
  };
  for (const line of spec.split('\n')) {
    if (line.trim() === '') continue;
    const space = line.indexOf(' ');
    const word = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (word === 'program') result.program = value;
    else if (word === 'arg') result.args.push(value);
    else if (word === 'read') result.read.push(value);
    else if (word === 'write') result.write.push(value);
    else if (word === 'time') result.time = positiveInteger(word, value);
    else if (word === 'memory') result.memory = positiveInteger(word, value);
    else throw new Error(`guest.start: unknown setting "${word}" in the spec`);
  }
  if (result.program === null) throw new Error('guest.start: the spec has no "program" line');
  return result;
}

// True if `path` is the directory `dir` or is inside it.
const isUnder = (dir, path) => path === dir || path.startsWith(dir === '/' ? dir : `${dir}/`);

// Creates the "guest" host module. Pass the result to boot() in its
// `modules` option.
export function guests() {
  // The running program (set when it first imports this module).
  let app = null;

  // The guests that are alive, by number. Each is:
  //   worker    its Web Worker
  //   time      its time limit in ms, or 0 for none
  //   unfinished how many pieces of work (its start-up, plus each message
  //             sent to it) it has not yet reported as done
  //   timer     the timeout for the piece of work it is doing now, or null
  const alive = new Map();
  let nextNumber = 1;

  // The data of the event that on-guest is being called for. `take`
  // reads it.
  let eventData = null;

  // Calls the program's on-guest for one event.
  const deliver = (g, kind, bytes) => {
    const outer = eventData;
    eventData = bytes;
    try {
      app.call('on-guest', g, kind);
    } finally {
      eventData = outer;
    }
  };

  // Ends guest g. If `reason` is not null, the program is told with an
  // "ended" event; `stop` passes null, because the program already knows.
  const end = (g, reason) => {
    const guest = alive.get(g);
    if (!guest) return;
    alive.delete(g);
    clearTimeout(guest.timer);
    guest.worker.terminate();
    if (reason !== null) deliver(g, ENDED, utf8.encode(reason));
  };

  // (Re)starts the guest's time limit. Called when the guest begins its
  // next piece of work: the limit applies to each piece separately. With
  // no limit, or no work left, there is no timer.
  const restartTimer = (g, guest) => {
    clearTimeout(guest.timer);
    guest.timer = guest.time > 0 && guest.unfinished > 0
      ? setTimeout(() => end(g, `time limit exceeded (${guest.time} ms)`), guest.time)
      : null;
  };

  // Starts a guest from a spec and returns its number. Throws an Error if
  // the spec is wrong or the program cannot be found.
  function start(specText) {
    const spec = parseSpec(specText);

    // The guest's program is read from the first program's files, which
    // in the browser are kept in memory (app.files).
    const files = app.files;
    const dir = resolvePath(app.cwd, spec.program);
    const list = files.get(`${dir}/program`);
    if (!list) throw new Error(`guest.start: no program found in ${spec.program}`);
    const names = text.decode(list).split('\n').filter((n) => n !== '');
    const linklets = new Map();
    for (const name of names) {
      const bytes = files.get(`${dir}/${name}.wasm`);
      if (!bytes) throw new Error(`guest.start: the program in ${spec.program} is missing ${name}.wasm`);
      linklets.set(name, bytes);
    }

    // The guest gets copies of the files under its `read` directories.
    // (postMessage copies them; the guest cannot change ours.)
    const readable = spec.read.map((d) => resolvePath(app.cwd, d));
    const granted = new Map();
    for (const [path, bytes] of files) if (readable.some((d) => isUnder(d, path))) granted.set(path, bytes);

    const g = nextNumber++;
    const worker = new Worker(new URL('./guest-worker.mjs', import.meta.url), { type: 'module' });
    // The guest's first piece of work is its own start-up.
    const guest = { worker, time: spec.time, unfinished: 1, timer: null };
    alive.set(g, guest);

    worker.onmessage = (e) => {
      // Ignore anything that arrives after the guest was ended.
      if (alive.get(g) !== guest) return;
      const m = e.data;
      if (m.type === 'output') deliver(g, m.fd === 2 ? STDERR : STDOUT, m.bytes);
      else if (m.type === 'message') deliver(g, MESSAGE, m.bytes);
      else if (m.type === 'done') {
        guest.unfinished--;
        restartTimer(g, guest);
        deliver(g, DONE, utf8.encode(m.trap));
      } else if (m.type === 'ended') end(g, m.reason);
    };
    // The worker script itself failed (for example, it could not be
    // loaded, or the browser ran out of memory for it).
    worker.onerror = (e) => {
      e.preventDefault();
      end(g, `error: ${e.message || 'the worker failed'}`);
    };
    worker.postMessage({
      type: 'start',
      names,
      linklets,
      files: granted,
      args: spec.args,
      cwd: app.cwd,
      writable: spec.write.map((d) => resolvePath(app.cwd, d)),
      memory: spec.memory,
    });
    restartTimer(g, guest);
    return g;
  }

  // The functions a program imports from "guest". `caller` gives access
  // to the calling instance's memory.
  return (caller, theApp) => {
    app = theApp;
    return {
      start(ptr, length) {
        try {
          return start(caller.string(ptr, length));
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
      },
      send(g, ptr, length) {
        const guest = alive.get(g);
        if (!guest) return -1;
        // slice() copies the bytes out of the program's memory. The copy
        // is then handed over to the worker rather than copied again.
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + length);
        guest.worker.postMessage({ type: 'message', bytes }, [bytes.buffer]);
        // If the guest was idle, it starts this message now, so its time
        // limit starts now too.
        if (guest.unfinished++ === 0) restartTimer(g, guest);
        return 0;
      },
      take(buf, cap) {
        if (!eventData) return 0;
        caller.memory().set(eventData.subarray(0, cap), caller.u(buf));
        return eventData.length;
      },
      stop(g) {
        end(g, null);
      },
    };
  };
}
