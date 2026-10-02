// Lifecycle: experimental.
//
// The host for a web page: runs a compiled Substrate program in a browser
// (spec section 4).
//
// Loading and linking modules, and the host functions, are in
// host/subhost-core.mjs, which the Node host shares. This file adds what
// is specific to a browser:
//   - the program's modules are fetched over HTTP;
//   - the program's "files" are a Map kept in memory, which can be filled
//     from file packs (host/web/pack.mjs);
//   - the program keeps running after its main function returns. On the
//     command line a program is over when main returns. A page stays
//     open, so the program's instances are kept, and the page calls the
//     program's functions again later, for example for each event.
//
// Usage:
//
//   import { boot } from './subhost-web.mjs';
//   const app = await boot({ program: 'program/', ... });
//
// boot's options:
//
//   program    the URL of the program's directory (what `sub build`
//              wrote, served as static files)
//   args       the program's command-line arguments (default: none)
//   files      a Map from path to bytes (Uint8Array): the files that the
//              program can read and write with host.read_file and
//              host.write_file. Nothing is written to disk.
//   packs      file packs to download and add to `files` first: a list of
//              [url, directory] pairs. Each pack's files are placed under
//              its directory.
//   cwd        the directory that relative paths start from (default "/")
//   programAt  if given, the program's own files are also added to
//              `files`, under this directory. The compiler needs this: it
//              reads the files of the build that is running it.
//   write      (fd, text) => ...: receives what the program writes to
//              standard output (fd 1) and standard error (fd 2), as text.
//              By default, lines go to console.log and console.error.
//   output     (fd, bytes) => ...: like `write`, but receives the raw
//              bytes. If given, `write` is not used.
//   mayWrite   (path) => true or false: whether the program may write the
//              file at this (absolute) path. By default it may write
//              anywhere.
//   memoryPages
//              a limit, in 64 KiB pages, on the size of each wasm memory
//              of the program (host/subhost-core.mjs). No limit by
//              default.
//   modules    extra host modules that the program may import from: an
//              object from module name to a function
//              (caller, app) => imports (host/subhost-core.mjs explains
//              host modules). host/web/dom.mjs is one.
//   onExit     (code) => ...: called if the program ends itself with
//              host.exit. After that the program is not called again.
//
// boot returns an `app` object once main has returned:
//
//   app.entry      the exports of the program's entry module
//   app.call(name, ...args)
//                  calls the function `name` of the entry module. Returns
//                  true if it returned normally; false if it trapped, or
//                  if the program has ended; undefined if there is no
//                  such function. A trap does not end the program: it is
//                  reported (by the program's on-trap, or else on
//                  standard error) and later calls still work (spec 4).
//   app.files      the Map of files
//   app.cwd        the directory that relative paths start from
//   app.started    what calling main returned (as app.call returns it)
//   app.ended      true once the program has ended itself
//
// run(options, names, linklets) is the same as boot for a program whose
// modules are already in memory. `names` lists the modules in load order
// and `linklets` is a Map from name to bytes. It does not fetch anything
// (so `program` and `packs` are not used) and returns `app` immediately.
// A guest's worker uses it (guest-worker.mjs).
import { createHost } from '../subhost-core.mjs';

const text = new TextDecoder();
const utf8 = new TextEncoder();

// host.exit must stop the program's code at once, and the only way to do
// that from a function wasm has called is to throw. This is what is
// thrown; `running` (below) catches it.
class Exit {
  constructor(code) {
    this.code = code;
  }
}

// Returns `path` as an absolute, normalised path: a relative path is
// taken to start from the directory `cwd`, and "." and ".." segments are
// resolved.
export function resolvePath(cwd, path) {
  const out = [];
  for (const seg of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

// Unpacks a file pack (see host/web/pack.mjs) into the Map `files`. Each
// file's path is placed under the directory `dir`. A pack is a sequence
// of records: the path's length (32 bits, little-endian), the path, the
// content's length (the same), and the content.
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

// Returns a function that accepts text in arbitrary pieces and calls
// `line` once for each complete line. Used to send a program's output to
// the console, which prints a line at a time.
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
  for (const [url, dir] of options.packs || []) unpack(await fetchBytes(url), dir, files);

  const names = text.decode(await fetchBytes(`${base}program`)).split('\n').filter((n) => n !== '');
  const linklets = new Map();
  await Promise.all(names.map(async (name) => {
    linklets.set(name, await fetchBytes(`${base}${encodeURIComponent(name)}.wasm`));
  }));
  if (options.programAt) {
    files.set(resolvePath(options.programAt, 'program'), utf8.encode(names.map((n) => `${n}\n`).join('')));
    for (const [name, bytes] of linklets) files.set(resolvePath(options.programAt, `${name}.wasm`), bytes);
  }
  return run({ ...options, files }, names, linklets);
}

export function run(options, names, linklets) {
  const cwd = options.cwd || '/';
  const files = options.files || new Map();

  const out = lines((l) => console.log(l));
  const err = lines((l) => console.error(l));
  const write = options.write || ((fd, piece) => (fd === 2 ? err : out)(piece));
  // One UTF-8 decoder per output stream. With { stream: true } a decoder
  // remembers an incomplete character at the end of one write and
  // finishes it with the next write.
  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
  const output = options.output || ((fd, bytes) => write(fd, decoders[fd].decode(bytes, { stream: true })));

  const app = { files, cwd, entry: null, ended: false };
  const modules = new Map();
  for (const [name, make] of Object.entries(options.modules || {})) modules.set(name, (caller) => make(caller, app));

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
    modules,
    memoryPages: options.memoryPages || 0,
  });
  app.host = host;

  // Runs f, which calls into the program. Returns what f returns, or
  // false if the program ended itself (host.exit) during the call or
  // before it.
  const running = (f) => {
    if (app.ended) return false;
    try {
      return f();
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      app.ended = true;
      if (options.onExit) options.onExit(e.code);
      return false;
    }
  };
  const report = (message) => output(2, utf8.encode(`error: ${message}\n`));

  app.call = (name, ...args) => {
    const f = app.entry && app.entry[name];
    if (typeof f !== 'function') return undefined;
    return running(() => host.call(app.entry, f, args, report));
  };

  running(() => {
    app.entry = host.load(names, (name) => linklets.get(name));
    if (!app.entry) {
      report(host.lastError);
      throw new Exit(2);
    }
    return true;
  });
  app.started = app.call('main');
  return app;
}
