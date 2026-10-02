// Lifecycle: permanent. The host of spec section 4 over a JavaScript engine's
// WebAssembly, V8's: what host/subhost.mjs, over Node, and
// host/web/subhost-web.mjs, in a browser, share. A platform gives it what
// differs between them: the program's arguments, its files, where its
// output goes and how it ends.
//
// createHost(platform) is one store: instances by name, the host imports,
// and the instantiate hook. platform has:
//
//   args                    the program's command-line arguments, strings
//   write(fd, bytes)        write bytes, a Uint8Array, to fd 1 or 2
//   readFile(path)          the file's bytes, a Uint8Array; or throws an
//                           Error whose message says why not
//   writeFile(path, bytes)  make or replace the file; or throws likewise
//   exit(code)              end the program with status code; does not
//                           return
//   modules                 a Map, name -> (caller) => imports: the host
//                           modules besides "host" that a linklet can
//                           import from, each given the calling instance,
//                           caller.memory() its memory's bytes and
//                           caller.exports its exports once it has them
//   keyOf(bytes)            optional: a hash of bytes that tells any two
//                           modules apart, a string
//
// A host module is how an embedder gives programs more than spec 4's
// imports, such as a page's document: a linklet reaches it by importing
// from its name, so a program's imports say what it can touch. The
// compiler's builds are given none, so that compile-time code stays
// reproducible (spec 4).

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

// The byte arrays parts, as one.
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

// A key for bytes, to find a module compiled from the same ones: two
// 32-bit FNV-1a hashes, from either end, and the length. The bytes are
// compared too (compile), so a key that two modules share costs only the
// comparison.
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
  // Every instance so far, by name: its exports.
  const registry = new Map();
  // Every module compiled so far, by the key of its bytes: each with the
  // bytes it was compiled from.
  const modules = new Map();
  // The message of the last failure, for host.error_message.
  let lastError = '';

  const trapper = new WebAssembly.Instance(new WebAssembly.Module(trapperBytes)).exports;
  let trapMessage = null;

  function hostTrap(message) {
    trapMessage = message;
    trapper.trap();
  }

  // A trap's message: the host's, if it made the trap, or the engine's.
  function trapMessageOf(e) {
    const m = trapMessage === null ? e.message : trapMessage;
    trapMessage = null;
    return m;
  }

  // The module of bytes, compiled once. A platform with a hash that tells
  // any two modules apart gives it as keyOf; without one, a module is
  // kept with its bytes, which those of the same key are compared with.
  function compile(bytes) {
    const key = platform.keyOf ? platform.keyOf(bytes) : keyOf(bytes);
    const known = modules.get(key);
    if (known) for (const k of known) if (platform.keyOf || sameBytes(k.bytes, bytes)) return k.module;
    const deferred = deferStart(bytes);
    const module = new WebAssembly.Module(deferred);
    const kept = { bytes: platform.keyOf ? null : bytes, module };
    if (known) known.push(kept);
    else modules.set(key, [kept]);
    // Moving the start function moves the code after it.
    noteLocations(module, deferred.length - bytes.length);
    return module;
  }

  // ---- source locations ----
  //
  // A module's source-locations section maps code offsets to where the code
  // comes from (spec 3.6). A backtrace names each frame's module, by the
  // module name its name section gives, and the frame's offset in it.
  const locations = new Map();

  // The locations in module, whose code is shift bytes after where the
  // compiler put it.
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

  // A trap's backtrace (spec 4): the wasm frames of error e, each with its
  // source location, in main or in a start function while the program
  // loads; the host's own frames are not the program's.
  function backtrace(e) {
    return (e.stack || '').split('\n').filter((l) => l.includes('wasm://') && !l.includes('subhost-trap'))
      .map(located).join('\n');
  }

  // A backtrace line of V8's, "at MODULE.f (wasm://wasm/MODULE-HASH:wasm-function[i]:0xOFFSET)",
  // as the frame's function and its source location, "at f FILE:LINE:COL",
  // if the frame has one; or as it is.
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

  // What a host function is given of the instance that calls it, self:
  // its memory's bytes, text in them, and its exports.
  function callerOf(self, who) {
    const memory = () => {
      const m = self.exports && self.exports.memory;
      if (!m) hostTrap(`${who}: the caller exports no memory, or is still starting`);
      return new Uint8Array(m.buffer);
    };
    return {
      memory,
      string: (ptr, len) => text.decode(memory().slice(ptr, ptr + len)),
      get exports() {
        return self.exports;
      },
      trap: hostTrap,
    };
  }

  // The host imports for one instance, self.exports once it exists. Every
  // pointer is into that instance's memory.
  function hostImports(self) {
    const { memory, string } = callerOf(self, 'host');
    return {
      write(fd, ptr, len) {
        platform.write(fd === 2 ? 2 : 1, memory().subarray(ptr, ptr + len));
        return len;
      },
      trap(ptr, len) {
        hostTrap(string(ptr, len));
      },
      instantiate(np, nl, bp, bl, mp, ml) {
        const name = string(np, nl);
        const bytes = memory().slice(bp, bp + bl);
        const map = importMap(memory().slice(mp, mp + ml));
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
        memory().set(b, bp);
        return b.length;
      },
      arg_count() {
        return platform.args.length;
      },
      arg(i, bp, cap) {
        if (i < 0 || i >= platform.args.length) return -1;
        const b = utf8.encode(platform.args[i]);
        memory().set(b.subarray(0, cap), bp);
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
        memory().set(b.subarray(0, cap), bp);
        return b.length;
      },
      write_file(pp, pl, bp, len) {
        const path = string(pp, pl);
        try {
          platform.writeFile(path, memory().slice(bp, bp + len));
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

  // Compile and instantiate bytes as instance name, linking each import to
  // the instance map names for its module, or to the instance of that name;
  // one from "host", or from a host module of the platform's, is that
  // module's for this instance. False, with lastError set, on failure.
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
      // An exception out of the start function goes on to the caller (spec 4).
      if (!(e instanceof WebAssembly.RuntimeError || e instanceof RangeError ||
            e instanceof WebAssembly.LinkError)) throw e;
      const where = backtrace(e);
      lastError = `instantiate: ${e instanceof WebAssembly.RuntimeError ? trapMessageOf(e) : e.message}${where ? `\n${where}` : ''}`;
      return false;
    }
    registry.set(name, self.exports);
    return true;
  }

  // Instantiate the program whose linklets are names, in order, each of
  // bytes bytesOf(name) (spec 4): its entry's exports, the last's; or
  // null, with lastError set, if one cannot be loaded.
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
    // A program without linklets has nothing to run.
    return names.length > 0 ? registry.get(names[names.length - 1]) : {};
  }

  // Call f, a function of the program's, the entry's exports being
  // entry, with args: true if it returned; false after a trap in it, or
  // an exception that escaped it, which the entry's on-trap, if it has
  // one, has reported (spec 4), reading the message with
  // host.error_message; else report is given the message. The store
  // stays usable after either.
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
          // It trapped too: report the first trap. One that ends the
          // program, as a platform's exit may, does.
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
