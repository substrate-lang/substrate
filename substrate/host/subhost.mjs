#!/usr/bin/env -S node --stack-size=4000
// Lifecycle: permanent. The host of spec section 4 over Node's V8; bin/sub
// runs the compiler on it. The stack limit, in KiB, is build/subhost's: 4 MiB
// (V8's default is under 1 MiB).
//
// host/subhost.mjs DIR [arg ...]: run the program sub build wrote to DIR,
// as build/subhost does.
import fs from 'node:fs';
import crypto from 'node:crypto';
import util from 'node:util';

const [dir, ...programArgs] = process.argv.slice(2);
if (!dir) {
  process.stderr.write('usage: node host/subhost.mjs DIR [arg ...]\n');
  process.exit(64);
}

const utf8 = new TextEncoder();
const text = new TextDecoder();

// Every instance so far, by name: its exports.
const registry = new Map();
// Every module compiled so far, by the hash of its bytes.
const modules = new Map();
// The message of the last failure, for host.error_message.
let lastError = '';

class Trap extends Error {}

// The system's message for a failed file operation, worded as C's
// strerror words it, as build/subhost reports it.
function systemMessage(e) {
  if (typeof e.errno !== 'number') return e.message;
  const m = util.getSystemErrorMessage(e.errno);
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function compile(bytes) {
  const key = crypto.createHash('sha256').update(bytes).digest('hex');
  let module = modules.get(key);
  if (!module) {
    const deferred = deferStart(bytes);
    module = new WebAssembly.Module(deferred);
    modules.set(key, module);
    // Moving the start function moves the code after it.
    noteLocations(module, deferred.length - bytes.length);
  }
  return module;
}

// ---- source locations ----
//
// A module's source-locations section maps code offsets to where the code
// comes from (spec 3.6). A backtrace names each frame's module, by the
// module name its name section gives, and the frame's offset in it.
const locations = new Map();

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

// A backtrace line of V8's, "at f (wasm://wasm/MODULE-HASH:wasm-function[i]:0xOFFSET)",
// with the source location of the frame added.
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
  return found && found.where ? `${line} ${found.where}` : line;
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

// The host imports for one instance, self.exports once it exists. Every
// pointer is into that instance's memory.
function hostImports(self) {
  const memory = () => {
    const m = self.exports && self.exports.memory;
    if (!m) throw new Trap('host: the caller exports no memory, or is still starting');
    return new Uint8Array(m.buffer);
  };
  const string = (ptr, len) => text.decode(memory().slice(ptr, ptr + len));
  return {
    write(fd, ptr, len) {
      fs.writeSync(fd === 2 ? 2 : 1, memory().subarray(ptr, ptr + len));
      return len;
    },
    trap(ptr, len) {
      throw new Trap(string(ptr, len));
    },
    instantiate(np, nl, bp, bl, mp, ml) {
      const name = string(np, nl);
      const bytes = memory().slice(bp, bp + bl);
      const map = importMap(memory().slice(mp, mp + ml));
      return instantiate(name, bytes, map) ? 0 : 1;
    },
    export_index(ip, il, fp, fl) {
      const table = self.exports.table;
      if (!table) throw new Trap('host.export_index: the caller exports no table');
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
      return programArgs.length;
    },
    arg(i, bp, cap) {
      if (i < 0 || i >= programArgs.length) return -1;
      const b = utf8.encode(programArgs[i]);
      memory().set(b.subarray(0, cap), bp);
      return b.length;
    },
    read_file(pp, pl, bp, cap) {
      const path = string(pp, pl);
      let b;
      try {
        b = fs.readFileSync(path);
      } catch (e) {
        lastError = `${path}: ${systemMessage(e)}`;
        return -1;
      }
      memory().set(b.subarray(0, cap), bp);
      return b.length;
    },
    write_file(pp, pl, bp, len) {
      const path = string(pp, pl);
      try {
        fs.writeFileSync(path, memory().slice(bp, bp + len));
      } catch (e) {
        lastError = `${path}: ${systemMessage(e)}`;
        return -1;
      }
      return 0;
    },
    exit(code) {
      process.exit(code);
    },
  };
}

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
  return Buffer.concat(parts);
}

// Compile and instantiate bytes as instance name, linking each import to
// the instance map names for its module, or to the instance of that name.
// False, with lastError set, on failure.
function instantiate(name, bytes, map) {
  let module;
  try {
    module = compile(bytes);
  } catch (e) {
    lastError = `compile: ${e.message}`;
    return false;
  }
  const self = {};
  let host = null;
  const imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    let value;
    if (imp.module === 'host') {
      host = host || hostImports(self);
      value = host[imp.name];
    } else {
      const exports = registry.get(map.get(imp.module) ?? imp.module);
      value = exports && exports[imp.name];
    }
    if (value === undefined) {
      lastError = `instantiate ${name}: no import ${map.get(imp.module) ?? imp.module}.${imp.name}`;
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
    if (!(e instanceof Trap || e instanceof WebAssembly.RuntimeError || e instanceof RangeError ||
          e instanceof WebAssembly.LinkError)) throw e;
    lastError = `instantiate: ${e.message}`;
    return false;
  }
  registry.set(name, self.exports);
  return true;
}

// A trap in main, or an exception that escapes it, reported as
// build/subhost reports it: what happened, then, for a trap, where. The
// program's on-trap, if it has one, reports it instead (spec 4), reading
// the message with host.error_message.
function fail(e, exports) {
  if (e instanceof Trap || e instanceof WebAssembly.RuntimeError || e instanceof RangeError) {
    // The wasm frames: the host's own are not the program's.
    const where = (e.stack || '').split('\n').filter((l) => l.includes('wasm://')).map(located).join('\n');
    lastError = `trap: ${e.message}\n${where}`;
  } else if (e instanceof WebAssembly.Exception) {
    lastError = 'uncaught exception';
  } else {
    throw e;
  }
  const onTrap = exports['on-trap'];
  if (typeof onTrap === 'function') {
    try {
      onTrap();
      process.exit(2);
    } catch (e2) {
      // It trapped too: report the first trap.
    }
  }
  process.stderr.write(`error: ${lastError}\n`);
  process.exit(2);
}

let names;
try {
  names = fs.readFileSync(`${dir}/program`, 'utf8').split('\n').filter((n) => n !== '');
} catch (e) {
  process.stderr.write(`subhost: cannot read ${dir}/program\n`);
  process.exit(1);
}
for (const name of names) {
  let bytes;
  try {
    bytes = fs.readFileSync(`${dir}/${name}.wasm`);
  } catch (e) {
    process.stderr.write(`subhost: cannot read ${dir}/${name}.wasm\n`);
    process.exit(1);
  }
  let loaded;
  try {
    loaded = instantiate(name, bytes, new Map());
  } catch (e) {
    if (!(e instanceof WebAssembly.Exception)) throw e;
    lastError = 'instantiate: uncaught exception';
  }
  if (!loaded) {
    process.stderr.write(`error: ${lastError}\n`);
    process.exit(2);
  }
}
// A program without a main function has nothing to run.
const entry = names.length > 0 ? registry.get(names[names.length - 1]) : {};
if (typeof entry.main === 'function') {
  try {
    entry.main();
  } catch (e) {
    fail(e, entry);
  }
}
