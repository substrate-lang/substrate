// The JavaScript host, shared by Node (subhost.mjs) and the browser (web/subhost-web.mjs).
import { createStreams, STREAM } from './streams.mjs';
import { joined } from './entries.mjs';

const utf8 = new TextEncoder();
const text = new TextDecoder();

// (module (func (export "trap") unreachable))
const trapperBytes = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02, 0x01,
  0x00, 0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00, 0x0a, 0x05, 0x01, 0x03, 0x00, 0x00,
  0x0b, 0x00, 0x14, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x00, 0x0d, 0x0c, 0x73, 0x75, 0x62, 0x68, 0x6f, 0x73,
  0x74, 0x2d, 0x74, 0x72, 0x61, 0x70,
]);

// Host imports get the calling module's memory from the instance's exports, and the exports
// don't exist until instantiation finishes. A wasm start function runs during instantiation, so
// it couldn't call the host. Instead we export the start function and call it ourselves after
// instantiating.
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

export class Exit {
  constructor(code, reason = '') {
    this.code = code;
    this.reason = reason;
  }
}

export function createHost(platform) {
  const registry = new Map();
  const modules = new Map();
  // A memory's malloc, from the module that exports both.
  const allocators = new WeakMap();
  let lastError = '';
  // The running program: its modules' names in load order, how to get one's bytes, and the files of the compiled
  // modules its build wrote, by name, or null.
  let programNames = [];
  let programBytes = null;
  let programCompiled = null;
  let entry = null;
  let onEvent = null;
  let onTrap = null;
  let ended = false;
  let running = false;
  let active = false;
  let draining = false;
  const queue = [];
  let current = null;
  let deliveries = 0;
  let warned = false;
  const closers = [];
  const streams = createStreams({
    raise: (kind, id, tag, value, bytes) => event(STREAM, kind, id, tag, value, bytes),
    forget: (id) => forgetEvents(STREAM, id),
    trap: (message) => hostTrap(message),
  });

  function forgetEvents(source, id) {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].source === source && queue[i].id === id) queue.splice(i, 1);
  }

  const trapper = new WebAssembly.Instance(new WebAssembly.Module(trapperBytes)).exports;
  let trapMessage = null;

  const COMPILE_TIME_HOST = new Set(['write', 'trap']);
  const refused = (what, where = 'while compiling') => () => hostTrap(`${what} is not available ${where}`);

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

  function guarded(module, name, f) {
    return (...args) => {
      try {
        return f(...args);
      } catch (e) {
        if (e instanceof Exit || e instanceof WebAssembly.RuntimeError || e instanceof WebAssembly.Exception) throw e;
        hostTrap(`${module}.${name}: ${e.message}`);
      }
    };
  }

  // giveIn copies bytes into a block from memory m's malloc, and stores the length at out unless out is 0.
  function giveIn(m, bytes, out, who) {
    const malloc = m && allocators.get(m);
    if (!malloc) hostTrap(`${who}: the caller's memory has no malloc`);
    const p = malloc(bytes.length) >>> 0;
    if (p === 0) hostTrap(`${who}: out of memory`);
    new Uint8Array(m.buffer).set(bytes, p);
    if (out) new DataView(m.buffer).setUint32(out >>> 0, bytes.length, true);
    return p;
  }

  function callerOf(self, who, made) {
    const memory = () => {
      const m = self.exports && self.exports.memory;
      if (!m) hostTrap(`${who}: the caller exports no memory, or is still starting`);
      return new Uint8Array(m.buffer);
    };
    const u = (ptr) => ptr >>> 0;
    const give = (bytes, out) => giveIn(self.exports && self.exports.memory, bytes, out, who);
    return {
      memory,
      u,
      string: (ptr, len) => text.decode(memory().slice(u(ptr), u(ptr) + len)),
      get exports() {
        return self.exports;
      },
      trap: hostTrap,
      write: (fd, bytes) => platform.write(fd === 2 ? 2 : 1, bytes),
      give,
      fail(err, message) {
        if (!err) return;
        const p = give(utf8.encode(message), u(err) + 4);
        new DataView(memory().buffer).setUint32(u(err), p, true);
      },
      event(kind, id, tag, value, bytes, data) {
        event(made.source, kind, id, tag, value, bytes, data);
      },
      forget(id) {
        forgetEvents(made.source, id);
      },
      current: () => current,
      grants: () => platform.grants,
      parseGrants: (list) => platform.parseGrants(list),
      moduleNames: () => (platform.modules ? [...platform.modules.keys()] : []),
      module: (name) => (platform.modules ? platform.modules.get(name) : undefined),
      program: () => ({ names: programNames, bytes: programBytes, compiled: programCompiled }),
      // named gives the module and the export name of the program's function at the index in the table, or null.
      named(index) {
        const table = self.exports.table;
        const f = table && index < table.length ? table.get(index) : null;
        if (typeof f !== 'function') return null;
        for (const name of programNames) {
          const exports = registry.get(name);
          for (const key of Object.keys(exports || {})) if (exports[key] === f) return [name, key];
        }
        return null;
      },
      streams: { add: streams.add, tag: streams.tag, drop: streams.drop, close: streams.close, open: streams.open },
    };
  }

  function eventImports(self) {
    const { give } = callerOf(self, 'events');
    return {
      take: (out) => (current && current.bytes ? give(current.bytes, out) : 0),
    };
  }

  function hostImports(self) {
    const { memory, string, u, give, fail } = callerOf(self, 'host');
    // These calls give bytes and failures as the host section of compiler/substrate.sub says.
    return {
      write(fd, ptr, len) {
        platform.write(fd === 2 ? 2 : 1, memory().subarray(u(ptr), u(ptr) + len));
        return len;
      },
      trap(ptr, len) {
        hostTrap(string(ptr, len));
      },
      // compileTime is 1 for code the compiler runs while compiling.
      instantiate(np, nl, bp, bl, mp, ml, compileTime, err) {
        const name = string(np, nl);
        const bytes = memory().slice(u(bp), u(bp) + bl);
        const map = importMap(memory().slice(u(mp), u(mp) + ml));
        if (instantiate(name, bytes, map, compileTime !== 0)) return 0;
        fail(err, lastError);
        return 1;
      },
      export_index(ip, il, fp, fl) {
        const table = self.exports.table;
        if (!table) hostTrap('host.export_index: the caller exports no table');
        const exports = registry.get(string(ip, il));
        const f = exports && exports[string(fp, fl)];
        return typeof f === 'function' ? table.grow(1, f) : -1;
      },
      arg(i, out) {
        if (i < 0 || i >= platform.args.length) return 0;
        const a = platform.args[i];
        return give(typeof a === 'string' ? utf8.encode(a) : a, out);
      },
      os(out) {
        return give(utf8.encode(platform.os), out);
      },
      exit(code, p, l) {
        throw new Exit(code, string(p, l));
      },
      program_modules(out) {
        return give(utf8.encode(joined(programNames)), out);
      },
      module_bytes(np, nl, out) {
        const name = string(np, nl);
        return programNames.includes(name) ? give(programBytes(name), out) : 0;
      },
      compiled_file(np, nl, out) {
        const bytes = programCompiled && programCompiled.get(string(np, nl));
        return bytes ? give(bytes, out) : 0;
      },
    };
  }

  function later(self, made, from, fname) {
    let f = null;
    return (...args) => {
      if (!f) {
        if (!made.has(from)) {
          const info = {};
          let factory;
          try {
            factory = platform.modules.get(from);
          } catch (e) {
            hostTrap(`${from}: ${e.message}`);
          }
          const { source, end: close, ...given } = factory(callerOf(self, from, info));
          info.source = source;
          const functions = {};
          for (const [n, g] of Object.entries(given)) functions[n] = guarded(from, n, g);
          if (close) closers.push(close);
          made.set(from, functions);
        }
        f = made.get(from)[fname];
        if (f === undefined) hostTrap(`${from}.${fname} is not a host function`);
      }
      return f(...args);
    };
  }

  function instantiate(name, bytes, map, compileTime = false) {
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
        if (compileTime && value && !COMPILE_TIME_HOST.has(imp.name)) value = refused(`host.${imp.name}`);
      } else if (imp.module === 'events') {
        if (!made.has('events')) made.set('events', eventImports(self));
        value = made.get('events')[imp.name];
        if (compileTime && value) value = refused(`events.${imp.name}`);
      } else if (imp.module === 'stream') {
        if (!made.has('stream')) made.set('stream', streams.imports(callerOf(self, 'stream')));
        value = made.get('stream')[imp.name];
        if (compileTime && value) value = refused(`stream.${imp.name}`);
      } else if (platform.absent && platform.absent.has(from)) {
        value = refused(`${from}.${imp.name}`, 'in a worker');
      } else if (platform.modules && platform.modules.has(from)) {
        value = compileTime ? refused(`${from}.${imp.name}`) : later(self, made, from, imp.name);
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
      const { memory, malloc } = self.exports;
      if (memory && typeof malloc === 'function' && !allocators.has(memory)) allocators.set(memory, malloc);
      const start = self.exports[START_EXPORT];
      if (start) start();
    } catch (e) {
      if (!(e instanceof WebAssembly.RuntimeError || e instanceof RangeError ||
            e instanceof WebAssembly.LinkError)) throw e;
      const where = backtrace(e);
      const what = e instanceof WebAssembly.LinkError ? 'instantiate' : 'trap';
      lastError = `${what}: ${e instanceof WebAssembly.RuntimeError ? trapMessageOf(e) : e.message}${where ? `\n${where}` : ''}`;
      return false;
    }
    registry.set(name, self.exports);
    return true;
  }

  function load(names, bytesOf, compiled = null) {
    programNames = names;
    programBytes = bytesOf;
    programCompiled = compiled;
    running = true;
    try {
      for (const name of names) {
        let loaded;
        try {
          loaded = instantiate(name, bytesOf(name), new Map());
        } catch (e) {
          if (e instanceof Exit) {
            exited(e);
            return {};
          }
          if (!(e instanceof WebAssembly.Exception)) throw e;
          lastError = 'uncaught exception';
        }
        if (!loaded) return null;
      }
    } finally {
      running = false;
    }
    entry = names.length > 0 ? registry.get(names[names.length - 1]) : {};
    onEvent = hook(names, 'on-event');
    onTrap = hook(names, 'on-trap');
    if (typeof entry.main !== 'function') drain();
    return entry;
  }

  // hook finds the named function in the main module, or else in the first module, the language's.
  function hook(names, name) {
    for (const m of [entry, registry.get(names[0])]) if (m && typeof m[name] === 'function') return m[name];
    return null;
  }

  // end runs when the program is over, with its exit code and any reason it gave, or with -1 and the reason after a trap.
  function end(code, reason) {
    ended = true;
    queue.length = 0;
    for (const close of closers.splice(0)) close();
    streams.end();
    if (platform.ended) platform.ended(code, reason);
  }

  function exited(e) {
    if (e.reason && e.code !== 0 && !platform.worker) {
      platform.write(2, utf8.encode(e.reason.endsWith('\n') ? e.reason : `${e.reason}\n`));
    }
    end(e.code, e.reason);
  }

  function trapped(e) {
    if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) {
      lastError = `trap: ${e instanceof WebAssembly.RuntimeError ? trapMessageOf(e) : e.message}\n${backtrace(e)}`;
    } else if (e instanceof WebAssembly.Exception) {
      lastError = 'uncaught exception';
    } else {
      return false;
    }
    return true;
  }

  function call(f, args) {
    if (ended) return false;
    const outer = running;
    const first = !active;
    running = true;
    if (first) {
      active = true;
      if (platform.active) platform.active(true);
    }
    try {
      f(...args);
      return true;
    } catch (e) {
      if (e instanceof Exit) {
        exited(e);
        return false;
      }
      if (!trapped(e)) throw e;
      // When on-trap returns 0, or there is none, the error is reported and the program ends.
      if (onTrap && allocators.has(entry.memory)) {
        try {
          const message = utf8.encode(lastError);
          if (onTrap(giveIn(entry.memory, message, 0, 'on-trap'), message.length) !== 0) return false;
        } catch (e2) {
          if (e2 instanceof Exit) {
            exited(e2);
            return false;
          }
          if (!trapped(e2)) throw e2;
        }
      }
      if (!platform.worker) platform.report(lastError);
      end(-1, lastError);
      return false;
    } finally {
      running = outer;
      if (!outer) drain();
      if (first) {
        active = false;
        if (platform.active) platform.active(false);
      }
    }
  }

  function event(source, kind, id, tag, value, bytes, data) {
    if (ended) return;
    queue.push({ source, kind, id, tag, value, bytes: bytes || null, data: data === undefined ? null : data });
    if (!running) drain();
  }

  function drain() {
    if (draining || running) return;
    draining = true;
    try {
      while (queue.length > 0 && !ended) {
        const e = queue.shift();
        let ok;
        if (onEvent) {
          current = e;
          try {
            ok = call(onEvent, [e.source, e.kind, e.id, e.tag, e.value]);
          } finally {
            current = null;
          }
          deliveries++;
        } else if (!warned) {
          warned = true;
          platform.report('an event arrived, but the program has no on-event');
        }
        if (platform.delivered) platform.delivered(e, ok);
      }
    } finally {
      draining = false;
    }
  }

  return {
    registry,
    instantiate,
    load,
    call,
    event,
    get ended() {
      return ended;
    },
    get deliveries() {
      return deliveries;
    },
    get onEvent() {
      return onEvent;
    },
    get lastError() {
      return lastError;
    },
  };
}
