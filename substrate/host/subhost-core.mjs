// The JavaScript host, shared by Node (subhost.mjs) and the browser (web/subhost-web.mjs).

const utf8 = new TextEncoder();
const text = new TextDecoder();

// Wasm can catch a JavaScript exception but not a trap, so the host traps by calling
// this module: (module (func (export "trap") unreachable)).
const trapperBytes = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02, 0x01,
  0x00, 0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00, 0x0a, 0x05, 0x01, 0x03, 0x00, 0x00,
  0x0b, 0x00, 0x14, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x00, 0x0d, 0x0c, 0x73, 0x75, 0x62, 0x68, 0x6f, 0x73,
  0x74, 0x2d, 0x74, 0x72, 0x61, 0x70,
]);

// Host imports reach their caller's memory through its exports, which exist only after
// instantiation: the start function is exported instead, and called after it.
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

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

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

// Different modules may get the same key: compile also compares their bytes.
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

function importMap(bytes) {
  const parts = text.decode(bytes).split('\0');
  const map = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i], parts[i + 1]);
  return map;
}

export function createHost(platform) {
  const registry = new Map();
  const modules = new Map();
  let lastError = '';

  const trapper = new WebAssembly.Instance(new WebAssembly.Module(trapperBytes)).exports;
  let trapMessage = null;

  function hostTrap(message) {
    trapMessage = message;
    trapper.trap();
  }

  function trapMessageOf(e) {
    const m = trapMessage === null ? e.message : trapMessage;
    trapMessage = null;
    return m;
  }

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
    // deferStart and limitMemory resize sections before the code, so the source-location
    // offsets move by the difference in length.
    noteLocations(module, deferred.length - bytes.length);
    return module;
  }

  const locations = new Map();

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

  function backtrace(e) {
    return (e.stack || '').split('\n').filter((l) => l.includes('wasm://') && !l.includes('subhost-trap'))
      .map(located).join('\n');
  }

  // V8 prints a wasm frame as: at MODULE.f (wasm://wasm/MODULE-HASH:wasm-function[i]:0xOFFSET)
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

  // A pointer arrives as a signed i32 and is taken unsigned (u): a memory can exceed 2 GB.
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
      // A wasm exception from the start function goes on to the caller; traps and link errors fail.
      if (!(e instanceof WebAssembly.RuntimeError || e instanceof RangeError ||
            e instanceof WebAssembly.LinkError)) throw e;
      const where = backtrace(e);
      lastError = `instantiate: ${e instanceof WebAssembly.RuntimeError ? trapMessageOf(e) : e.message}${where ? `\n${where}` : ''}`;
      return false;
    }
    registry.set(name, self.exports);
    return true;
  }

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
    return names.length > 0 ? registry.get(names[names.length - 1]) : {};
  }

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
          // on-trap trapped too: report the original trap. Anything else, such as a platform's
          // exit, is passed on.
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
