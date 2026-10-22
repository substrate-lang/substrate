// The host for a web page: runs a program in a browser, its files kept in memory.
import { createHost, Exit } from '../subhost-core.mjs';

const text = new TextDecoder();
const utf8 = new TextEncoder();

export function resolvePath(cwd, path) {
  const out = [];
  for (const seg of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

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
  return run({ ...options, files }, names, wasm);
}

export function run(options, names, wasm) {
  const cwd = options.cwd || '/';
  const files = options.files || new Map();

  const out = lines((l) => console.log(l));
  const err = lines((l) => console.error(l));
  const write = options.write || ((fd, piece) => (fd === 2 ? err : out)(piece));
  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
  const output = options.output || ((fd, bytes) => write(fd, decoders[fd].decode(bytes, { stream: true })));

  const app = { files, cwd, entry: null, ended: false };
  const modules = new Map();
  for (const [name, make] of Object.entries(options.modules || {})) modules.set(name, (caller) => make(caller, app));
  const report = (message) => output(2, utf8.encode(`error: ${message}\n`));
  const ended = (reason) => {
    app.ended = true;
    if (options.onEnd) options.onEnd(reason);
  };

  const host = createHost({
    args: options.args || [],
    write: output,
    readFile(path) {
      const bytes = files.get(resolvePath(cwd, path));
      if (!bytes) throw new Error('No such file or directory');
      return bytes;
    },
    writeFile(path, bytes) {
      const to = resolvePath(cwd, path);
      if (options.mayWrite && !options.mayWrite(to)) throw new Error('Permission denied');
      files.set(to, bytes);
    },
    exit(code) {
      throw new Exit(code);
    },
    report,
    ended,
    delivered: options.delivered,
    modules,
    memoryPages: options.memoryPages || 0,
  });
  app.host = host;

  app.call = (name, ...args) => {
    const f = app.entry && app.entry[name];
    if (typeof f !== 'function') return undefined;
    return host.call(f, args);
  };

  app.entry = host.load(names, (name) => wasm.get(name));
  if (!app.entry) {
    report(host.lastError);
    ended('exit 2');
  }
  app.started = app.call('main');
  return app;
}
