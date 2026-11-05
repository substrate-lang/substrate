// The host for a web page: runs a program in a browser, its files kept in memory. A page has every grant, and its
// workers may be given fewer, and fakes (worker-script.mjs).
import { createHost } from '../subhost-core.mjs';
import { fsModule } from '../fs.mjs';
import { allGrants, pairsFrom, requestOf } from '../grants.mjs';
import { pageFiles, resolvePath } from './fs.mjs';

const text = new TextDecoder();
const utf8 = new TextEncoder();

export function unpack(bytes, dir, files) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; ) {
    const pathLength = view.getUint32(at, true);
    const path = text.decode(bytes.subarray(at + 4, at + 4 + pathLength));
    at += 4 + pathLength;
    const length = view.getUint32(at, true);
    files.set(resolvePath(dir, path), bytes.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchListed(url, dir, files) {
  const list = new URL(url, globalThis.document ? document.baseURI : globalThis.location.href);
  const paths = text.decode(await fetchBytes(list)).split('\n').filter((p) => p !== '');
  await Promise.all(paths.map(async (path) => {
    const from = new URL(path.split('/').map(encodeURIComponent).join('/'), list);
    files.set(resolvePath(dir, path), await fetchBytes(from));
  }));
}

function lines(line) {
  let pending = '';
  return (piece) => {
    pending += piece;
    for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) {
      line(pending.slice(0, i));
      pending = pending.slice(i + 1);
    }
  };
}

export function importedModules(bytes) {
  const names = new Set();
  let at = 8;
  const u32 = () => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      const b = bytes[at++];
      n += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return n;
    }
  };
  const limits = () => {
    const flags = u32();
    u32();
    if (flags & 1) u32();
  };
  while (at < bytes.length) {
    const id = bytes[at++];
    const end = u32() + at;
    if (id !== 2) {
      at = end;
      continue;
    }
    for (let count = u32(); count > 0; count--) {
      const length = u32();
      names.add(text.decode(bytes.subarray(at, at + length)));
      at += length;
      const field = u32();
      at += field;
      const kind = bytes[at++];
      if (kind === 0) u32();
      else if (kind === 1) {
        at++;
        limits();
      } else if (kind === 2) limits();
      else if (kind === 3) at += 2;
      else if (kind === 4) {
        at++;
        u32();
      }
    }
    break;
  }
  return names;
}

// options.modules is the modules, or a function that takes the names the program imports and gives the modules.
export async function boot(options) {
  const base = options.program.endsWith('/') ? options.program : `${options.program}/`;
  const files = options.files || new Map();
  for (const [url, dir] of options.lists || []) await fetchListed(url, dir, files);
  for (const [url, dir] of options.packs || []) unpack(await fetchBytes(url), dir, files);

  const names = text.decode(await fetchBytes(`${base}program`)).split('\n').filter((n) => n !== '');
  const wasm = new Map();
  await Promise.all(names.map(async (name) => {
    wasm.set(name, await fetchBytes(`${base}${encodeURIComponent(name)}.wasm`));
  }));
  let { modules } = options;
  if (typeof modules === 'function') {
    const wanted = new Set();
    for (const bytes of wasm.values()) for (const name of importedModules(bytes)) wanted.add(name);
    modules = await modules(wanted);
  }
  return run({ ...options, files, modules }, names, wasm);
}

export function run(options, names, wasm) {
  const cwd = options.cwd || '/';
  const files = options.files || new Map();
  const grants = options.grants || allGrants();

  const out = lines((l) => console.log(l));
  const err = lines((l) => console.error(l));
  const write = options.write || ((fd, piece) => (fd === 2 ? err : out)(piece));
  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
  const output = options.output || ((fd, bytes) => write(fd, decoders[fd].decode(bytes, { stream: true })));

  const app = { files, cwd, entry: null, ended: false, realTime: [] };
  const modules = new Map();
  for (const [name, make] of Object.entries(options.modules || {})) modules.set(name, (caller) => make(caller, app));
  if (!modules.has('fs')) modules.set('fs', fsModule(pageFiles(files, cwd, grants)));
  const report = (message) => output(2, utf8.encode(`error: ${message}\n`));
  const ended = (code, reason) => {
    app.ended = true;
    if (options.onEnd) options.onEnd(code, reason);
  };

  const host = createHost({
    args: options.args || [],
    os: 'web',
    write: output,
    worker: Boolean(options.entry),
    report,
    ended,
    delivered: options.delivered,
    active: options.active,
    modules,
    absent: options.absent,
    grants,
    parseGrants: (list) => requestOf(pairsFrom(list), (p) => resolvePath(cwd, p)),
    memoryPages: options.memoryPages || 0,
  });
  app.host = host;

  app.call = (name, ...args) => {
    const f = app.entry && app.entry[name];
    if (typeof f !== 'function') return undefined;
    return host.call(f, args);
  };

  app.entry = host.load(names, (name) => wasm.get(name));
  if (!app.entry && options.entry) {
    ended(2, host.lastError);
  } else if (!app.entry) {
    report(host.lastError);
    ended(2, '');
  }
  // A worker's function comes as its module and export name.
  if (options.entry) {
    const exports = app.entry && host.registry.get(options.entry[0]);
    app.worker = exports && exports[options.entry[1]];
    app.started = typeof app.worker === 'function' ? host.call(app.worker, []) : undefined;
  } else {
    app.started = app.call('main');
  }
  return app;
}
