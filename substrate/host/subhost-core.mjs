// Lifecycle: permanent.
//
// The JavaScript host: the part that Node and the browser share.
//
// A "host" is what loads and runs a compiled Substrate program (spec
// section 4). It instantiates the program's wasm modules, links them to
// each other, and provides the "host" imports: writing output, reading
// files, instantiating more modules at run time, and so on.
//
// This file is everything that does not depend on where the host runs.
// Two small adapters supply the rest:
//
//   host/subhost.mjs           for Node: real files, the process's output
//   host/web/subhost-web.mjs   for a browser: files kept in memory
//
// createHost(platform) creates one "store": a set of instances that can
// link to each other. `platform` supplies what differs between Node and
// the browser:
//
//   args                    the program's command-line arguments (strings)
//   write(fd, bytes)        writes bytes (a Uint8Array) to standard output
//                           (fd 1) or standard error (fd 2)
//   readFile(path)          returns the file's bytes as a Uint8Array, or
//                           throws an Error whose message says what went
//                           wrong
//   writeFile(path, bytes)  creates or replaces the file, or throws in the
//                           same way
//   exit(code)              ends the program with the given status. It
//                           must not return.
//   modules                 optional: extra host modules (see below), as a
//                           Map from a module's name to a function
//                           (caller) => imports
//   keyOf(bytes)            optional: a hash of a module's bytes, as a
//                           string, strong enough that two different
//                           modules never get the same one (see compile)
//   memoryPages             optional: a limit, in 64 KiB pages, on the size
//                           of each wasm memory of the program (see
//                           limitMemory)
//
// Host modules. Besides "host", a platform can offer programs more
// modules of host functions, each under its own name. An example is
// "dom", which lets a program draw on a web page. A program uses one
// simply by importing from that name. The module's functions are created
// separately for each instance that imports them, by calling the module's
// function with a `caller` object (see callerOf) through which they can
// reach that instance's memory.
//
// A program can only use the host modules it is given, so they also work
// as permissions. The compiler itself is run with none. Code that runs at
// compile time (macros) can therefore only use the standard host
// functions, which keeps builds reproducible (spec 4).
//
// createHost returns { registry, instantiate, load, call, lastError }.
// `registry` is the Map of instances by name; the others are documented
// where they are defined, below.

const utf8 = new TextEncoder();
const text = new TextDecoder();

// A trap the host makes, host.trap's among them, with a message. Wasm
// code can catch a JavaScript exception, with catch_all, but not a trap
// (spec 4), so the host keeps the message and traps in wasm, calling this
// module: (module $subhost-trap (func (export "trap") unreachable)).
const trapperBytes = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02, 0x01,
  0x00, 0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00, 0x0a, 0x05, 0x01, 0x03, 0x00, 0x00,
  0x0b, 0x00, 0x14, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x00, 0x0d, 0x0c, 0x73, 0x75, 0x62, 0x68, 0x6f, 0x73,
  0x74, 0x2d, 0x74, 0x72, 0x61, 0x70,
]);

// ---- start functions ----
//
// A host import gets no reference to the instance calling it, so the host
// finds that instance's memory and table through its exports, which exist
// only once instantiation returns. Wasm runs a module's start function
// during instantiation, so the host takes out the start section, exports
// the start function under this name instead, and calls it after.
const START_EXPORT = '__subhost_start';

function readU32(bytes, pos) {
  let n = 0;
  let shift = 0;
  let b;
  do {
    b = bytes[pos++];
    n |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [n >>> 0, pos];
}

function u32(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

// Joins the byte arrays in `parts` into one Uint8Array.
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Module bytes with the start section, if any, replaced by an export.
function deferStart(bytes) {
  const sections = [];
  for (let pos = 8; pos < bytes.length; ) {
    const [size, body] = readU32(bytes, pos + 1);
    sections.push({ id: bytes[pos], start: pos, body, end: body + size });
    pos = body + size;
  }
  const start = sections.find((s) => s.id === 8);
  if (!start) return bytes;
  const [func] = readU32(bytes, start.body);
  const name = utf8.encode(START_EXPORT);
  const entry = [...u32(name.length), ...name, 0, ...u32(func)];
  // The export section comes just before the start section; without one,
  // the new one takes the start section's place.
  const old = sections.find((s) => s.id === 7);
  let body = [...u32(1), ...entry];
  if (old) {
    const [count, rest] = readU32(bytes, old.body);
    body = [...u32(count + 1), ...bytes.subarray(rest, old.end), ...entry];
  }
  const exports = Uint8Array.from([7, ...u32(body.length), ...body]);
  const parts = [bytes.subarray(0, 8)];
  for (const s of sections) {
    if (s === old || (s === start && !old)) parts.push(exports);
    else if (s !== start) parts.push(bytes.subarray(s.start, s.end));
  }
  return concat(parts);
}

// Returns a wasm module's bytes, changed so that every linear memory the
// module defines can grow to at most `pages` pages (64 KiB each).
//
// It rewrites the module's memory section so that each memory declares
// that maximum size. The engine then enforces it: memory.grow fails
// (returns -1) at the limit, just as it does when the machine is out of
// memory. Throws an Error if a memory's initial size is already above the
// limit. Guests with a memory limit use this (host/web/guest.mjs).
function limitMemory(bytes, pages) {
  let section = null;
  for (let pos = 8; pos < bytes.length; ) {
    const [size, body] = readU32(bytes, pos + 1);
    if (bytes[pos] === 5) section = { start: pos, body, end: body + size };
    pos = body + size;
  }
  if (!section) return bytes;
  let [count, pos] = readU32(bytes, section.body);
  const body = [...u32(count)];
  for (; count > 0; count--) {
    const flags = bytes[pos++];
    // Bit 2 of the flags marks a memory with 64-bit addresses, whose
    // limits are encoded differently. This function does not support it.
    if (flags & 4) throw new Error('a memory of 64-bit addresses, which a limited store has none of');
    let min;
    let max = pages;
    [min, pos] = readU32(bytes, pos);
    if (flags & 1) {
      let declared;
      [declared, pos] = readU32(bytes, pos);
      max = Math.min(declared, pages);
    }
    if (min > pages) throw new Error(`a memory of ${min} pages, where the most is ${pages}`);
    body.push(flags | 1, ...u32(min), ...u32(max));
  }
  return concat([bytes.subarray(0, section.start), Uint8Array.from([5, ...u32(body.length), ...body]),
    bytes.subarray(section.end)]);
}

// Returns a key for a module's bytes, used to look up a module that was
// already compiled from the same bytes. The key is two 32-bit FNV-1a
// hashes (one over the bytes forwards, one backwards) plus the length.
// Different modules could in theory get the same key, so `compile` also
// compares the bytes themselves; a clash only costs that comparison.
function keyOf(bytes) {
  let a = 0x811c9dc5;
  let b = 0x811c9dc5;
  for (let i = 0, j = bytes.length - 1; i < bytes.length; i++, j--) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[j], 0x01000193);
  }
  return `${bytes.length}:${a >>> 0}:${b >>> 0}`;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function reader(buffer) {
  const b = new Uint8Array(buffer);
  let pos = 0;
  const r = {
    done: () => pos >= b.length,
    u32() {
      let n = 0;
      let shift = 0;
      let x;
      do {
        x = b[pos++];
        n += (x & 0x7f) * 2 ** shift;
        shift += 7;
      } while (x & 0x80);
      return n;
    },
    name() {
      const n = r.u32();
      const s = text.decode(b.subarray(pos, pos + n));
      pos += n;
      return s;
    },
    bytes(n) {
      const s = b.subarray(pos, pos + n);
      pos += n;
      return s;
    },
  };
  return r;
}

// The import map a module is instantiated with (spec 4), from its bytes:
// pairs of names, a module's then its instance's, each followed by a zero
// byte.
function importMap(bytes) {
  const parts = text.decode(bytes).split('\0');
  const map = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i], parts[i + 1]);
  return map;
}

export function createHost(platform) {
  // Every instance created so far: a Map from its name to its exports.
  const registry = new Map();
  // Every module compiled so far: a Map from the key of its bytes to a
  // list of { bytes, module }.
  const modules = new Map();
  // The message of the most recent failure. A program reads it with
  // host.error_message.
  let lastError = '';

  const trapper = new WebAssembly.Instance(new WebAssembly.Module(trapperBytes)).exports;
  let trapMessage = null;

  function hostTrap(message) {
    trapMessage = message;
    trapper.trap();
  }

  // Returns the message for a trap: the host's own message if the host
  // caused the trap (hostTrap), otherwise the engine's.
  function trapMessageOf(e) {
    const m = trapMessage === null ? e.message : trapMessage;
    trapMessage = null;
    return m;
  }

  // Compiles a module, or returns the module already compiled from the
  // same bytes.
  //
  // If the platform provides keyOf, its key alone identifies a module.
  // Otherwise the weaker built-in keyOf is used, and the bytes are kept
  // and compared as well.
  function compile(bytes) {
    const key = platform.keyOf ? platform.keyOf(bytes) : keyOf(bytes);
    const known = modules.get(key);
    if (known) for (const k of known) if (platform.keyOf || sameBytes(k.bytes, bytes)) return k.module;
    let deferred = deferStart(bytes);
    if (platform.memoryPages) deferred = limitMemory(deferred, platform.memoryPages);
    const module = new WebAssembly.Module(deferred);
    const kept = { bytes: platform.keyOf ? null : bytes, module };
    if (known) known.push(kept);
    else modules.set(key, [kept]);
    // The source-location table refers to code by its offset in the
    // module. deferStart and limitMemory change the size of sections that
    // come before the code, so the code has moved by the difference in
    // length.
    noteLocations(module, deferred.length - bytes.length);
    return module;
  }

  // ---- Source locations for backtraces ----
  //
  // A module compiled by `sub` can contain a custom section named
  // "source-locations". It maps offsets in the module's code to the
  // source file, line and column that the code came from (spec 3.6).
  // When a trap happens, the engine's stack trace gives each frame's
  // module name and code offset, and this table turns those into a source
  // location.
  const locations = new Map();

  // Reads a module's source-locations section and stores it under the
  // module's name. `shift` is how far the module's code has moved from
  // where the compiler put it (see compile).
  function noteLocations(module, shift) {
    const [section] = WebAssembly.Module.customSections(module, 'source-locations');
    const [names] = WebAssembly.Module.customSections(module, 'name');
    if (!section || !names) return;
    let moduleName = null;
    const n = reader(names);
    while (!n.done() && moduleName === null) {
      const id = n.u32();
      const size = n.u32();
      if (id === 0) moduleName = n.name();
      else n.bytes(size);
    }
    if (moduleName === null) return;
    const r = reader(section);
    const files = [];
    for (let i = r.u32(); i > 0; i--) files.push(r.name());
    const entries = [];
    let at = 0;
    for (let i = r.u32(); i > 0; i--) {
      at += r.u32();
      const file = r.u32();
      const line = r.u32();
      const col = r.u32();
      entries.push({ at: at + shift, where: line === 0 ? null : `${files[file]}:${line}:${col + 1}` });
    }
    locations.set(moduleName, entries);
  }

  // Returns a trap's backtrace as text: one line per wasm frame, with its
  // source location where that is known (spec 4). The host's own
  // JavaScript frames are left out.
  function backtrace(e) {
    return (e.stack || '').split('\n').filter((l) => l.includes('wasm://') && !l.includes('subhost-trap'))
      .map(located).join('\n');
  }

  // Rewrites one line of a V8 stack trace. V8 prints a wasm frame as
  //   at MODULE.f (wasm://wasm/MODULE-HASH:wasm-function[i]:0xOFFSET)
  // If the frame's source location is known, the line becomes
  //   at f FILE:LINE:COL
  // Otherwise the line is returned unchanged.
  function located(line) {
    const m = /wasm:\/\/wasm\/(.*)-[0-9a-f]+:wasm-function\[\d+\]:0x([0-9a-f]+)/.exec(line);
    const entries = m && locations.get(m[1]);
    if (!entries) return line;
    const offset = parseInt(m[2], 16);
    let lo = 0;
    let hi = entries.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].at <= offset) {
        found = entries[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (!found || !found.where) return line;
    const named = /^(\s*at )(.*) \(wasm:/.exec(line);
    if (!named) return `${line} ${found.where}`;
    const f = named[2].startsWith(`${m[1]}.`) ? named[2].slice(m[1].length + 1) : named[2];
    return `${named[1]}${f} ${found.where}`;
  }

  // Builds the `caller` object through which host functions reach the
  // instance that called them. `self.exports` is that instance's exports,
  // and `who` names the host module, for error messages.
  //   memory()          the instance's memory, as a Uint8Array
  //   string(ptr, len)  the text at that address in its memory
  //   exports           its exports
  //   trap(message)     traps, with a message
  //   error(message)    sets the message that host.error_message returns
  function callerOf(self, who) {
    const memory = () => {
      const m = self.exports && self.exports.memory;
      if (!m) hostTrap(`${who}: the caller exports no memory, or is still starting`);
      return new Uint8Array(m.buffer);
    };
    const u = (ptr) => ptr >>> 0;
    return {
      memory,
      u,
      string: (ptr, len) => text.decode(memory().slice(u(ptr), u(ptr) + len)),
      get exports() {
        return self.exports;
      },
      trap: hostTrap,
      error(message) {
        lastError = message;
      },
    };
  }

  // Returns the functions of the "host" module (spec 4) for one instance.
  // Every pointer argument is an address in that instance's memory: an
  // i32, which arrives signed, taken unsigned (u), since a memory can be
  // larger than 2 GB.
  // `self.exports` is filled in once the instance exists.
  function hostImports(self) {
    const { memory, string, u } = callerOf(self, 'host');
    return {
      write(fd, ptr, len) {
        platform.write(fd === 2 ? 2 : 1, memory().subarray(u(ptr), u(ptr) + len));
        return len;
      },
      trap(ptr, len) {
        hostTrap(string(ptr, len));
      },
      instantiate(np, nl, bp, bl, mp, ml) {
        const name = string(np, nl);
        const bytes = memory().slice(u(bp), u(bp) + bl);
        const map = importMap(memory().slice(u(mp), u(mp) + ml));
        return instantiate(name, bytes, map) ? 0 : 1;
      },
      export_index(ip, il, fp, fl) {
        const table = self.exports.table;
        if (!table) hostTrap('host.export_index: the caller exports no table');
        const exports = registry.get(string(ip, il));
        const f = exports && exports[string(fp, fl)];
        return typeof f === 'function' ? table.grow(1, f) : -1;
      },
      error_message(bp, cap) {
        const b = utf8.encode(lastError).subarray(0, cap);
        memory().set(b, u(bp));
        return b.length;
      },
      arg_count() {
        return platform.args.length;
      },
      arg(i, bp, cap) {
        if (i < 0 || i >= platform.args.length) return -1;
        const b = utf8.encode(platform.args[i]);
        memory().set(b.subarray(0, cap), u(bp));
        return b.length;
      },
      read_file(pp, pl, bp, cap) {
        const path = string(pp, pl);
        let b;
        try {
          b = platform.readFile(path);
        } catch (e) {
          lastError = `${path}: ${e.message}`;
          return -1;
        }
        memory().set(b.subarray(0, cap), u(bp));
        return b.length;
      },
      write_file(pp, pl, bp, len) {
        const path = string(pp, pl);
        try {
          platform.writeFile(path, memory().slice(u(bp), u(bp) + len));
        } catch (e) {
          lastError = `${path}: ${e.message}`;
          return -1;
        }
        return 0;
      },
      exit(code) {
        platform.exit(code);
      },
    };
  }

  // Compiles `bytes` and instantiates the module under the name `name`.
  // Each import is resolved as follows:
  //   - from "host": the standard host functions (hostImports);
  //   - from a host module that the platform provides: that module's
  //     functions;
  //   - otherwise: an export of an existing instance. `map` can redirect
  //     the lookup: an import from module M is taken from the instance
  //     named map.get(M), or from the instance named M if the map has no
  //     entry for it.
  // Returns true on success. On failure, returns false and sets
  // lastError.
  function instantiate(name, bytes, map) {
    let module;
    try {
      module = compile(bytes);
    } catch (e) {
      lastError = `compile: ${e.message}`;
      return false;
    }
    const self = {};
    const made = new Map();
    const imports = {};
    for (const imp of WebAssembly.Module.imports(module)) {
      const from = map.get(imp.module) ?? imp.module;
      let value;
      if (imp.module === 'host') {
        if (!made.has('host')) made.set('host', hostImports(self));
        value = made.get('host')[imp.name];
      } else if (platform.modules && platform.modules.has(from)) {
        if (!made.has(from)) made.set(from, platform.modules.get(from)(callerOf(self, from)));
        value = made.get(from)[imp.name];
      } else {
        const exports = registry.get(from);
        value = exports && exports[imp.name];
      }
      if (value === undefined) {
        lastError = `instantiate ${name}: no import ${from}.${imp.name}`;
        return false;
      }
      (imports[imp.module] ||= {})[imp.name] = value;
    }
    try {
      self.exports = new WebAssembly.Instance(module, imports).exports;
      const start = self.exports[START_EXPORT];
      if (start) start();
    } catch (e) {
      // Traps and link errors are reported as a failed instantiation. A
      // wasm exception thrown by the start function is passed on to the
      // caller instead (spec 4).
      if (!(e instanceof WebAssembly.RuntimeError || e instanceof RangeError ||
            e instanceof WebAssembly.LinkError)) throw e;
      const where = backtrace(e);
      lastError = `instantiate: ${e instanceof WebAssembly.RuntimeError ? trapMessageOf(e) : e.message}${where ? `\n${where}` : ''}`;
      return false;
    }
    registry.set(name, self.exports);
    return true;
  }

  // Loads a program: instantiates the modules listed in `names`, in
  // order. `bytesOf(name)` returns a module's bytes. Returns the exports
  // of the last module, which is the program's entry; or null, with
  // lastError set, if a module cannot be loaded.
  function load(names, bytesOf) {
    for (const name of names) {
      let loaded;
      try {
        loaded = instantiate(name, bytesOf(name), new Map());
      } catch (e) {
        if (!(e instanceof WebAssembly.Exception)) throw e;
        lastError = 'instantiate: uncaught exception';
      }
      if (!loaded) return null;
    }
    // A program with no modules has no entry: return an empty object.
    return names.length > 0 ? registry.get(names[names.length - 1]) : {};
  }

  // Calls `f`, one of the program's functions, with `args`. `entry` is
  // the program's entry exports.
  //
  // Returns true if f returned normally. If f trapped, or threw a wasm
  // exception that nothing caught, returns false, after:
  //   - setting lastError to the message and backtrace; and
  //   - calling the program's exported on-trap function, if it has one,
  //     so that the program can report the problem itself (it reads the
  //     message with host.error_message) and recover (spec 4); or
  //   - calling `report(message)`, if the program has no on-trap.
  // The store stays usable in either case: later calls still work.
  function call(entry, f, args, report) {
    try {
      f(...args);
      return true;
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) {
        lastError = `trap: ${e instanceof WebAssembly.RuntimeError ? trapMessageOf(e) : e.message}\n${backtrace(e)}`;
      } else if (e instanceof WebAssembly.Exception) {
        lastError = 'uncaught exception';
      } else {
        throw e;
      }
      const onTrap = entry['on-trap'];
      if (typeof onTrap === 'function') {
        try {
          onTrap();
          return false;
        } catch (e2) {
          // on-trap trapped as well. Fall through and report the original
          // trap. Anything else that was thrown is passed on; that includes
          // what a platform throws to end the program from host.exit.
          if (!(e2 instanceof WebAssembly.RuntimeError || e2 instanceof RangeError ||
                e2 instanceof WebAssembly.Exception)) throw e2;
        }
      }
      report(lastError);
      return false;
    }
  }

  return {
    registry,
    instantiate,
    load,
    call,
    get lastError() {
      return lastError;
    },
  };
}
