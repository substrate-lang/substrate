// Lifecycle: experimental. The host of spec section 4 in a browser's page:
// host/subhost-core.mjs's store, host imports and instantiate hook, with
// what a page gives them. A program is the directory sub build wrote,
// served as files: its linklets are fetched, then instantiated in order
// and its main called, as host/subhost.mjs does. Unlike a process, a page
// goes on after main returns: the program's instances stay, and the page
// calls the entry's functions again, for its events.
//
//   import { boot } from './subhost-web.mjs';
//   const app = await boot({ program: 'program/', ... });
//
// boot's options:
//
//   program   the URL of the program's directory
//   args      its command-line arguments (none)
//   files     a Map, path -> bytes: the files the program reads and
//             writes (host.read_file, host.write_file), which are in
//             memory; and, with packs, the URLs of file packs
//             (host/web/pack.mjs) to fill it from first, each [url, dir],
//             its files' paths completed from dir
//   cwd       the directory a relative path is completed from ("/")
//   programAt the directory the program's own files are in, among files,
//             for a program that reads its build, as the compiler does
//             (-r DIR); none if not given
//   write     (fd, text) => ..., for the text the program writes to its
//             standard output, 1, and error, 2: the console's log and
//             error, a line at a time, if not given
//   modules   an object, name -> (caller, app) => imports: the host
//             modules the program may import from (host/subhost-core.mjs)
//   onExit    (code) => ..., called when the program ends itself
//             (host.exit); it is not called again after
//
// and what it returns, once main has returned:
//
//   app.entry              the entry linklet's exports
//   app.call(name, ...args) call the entry's function name: true, false
//                          after a trap or if the program has ended, or
//                          undefined if it has no such function. A trap
//                          is reported by the entry's on-trap, or else
//                          written to the standard error (spec 4), and
//                          the program goes on.
//   app.files              the files
import { createHost } from '../subhost-core.mjs';

const text = new TextDecoder();
const utf8 = new TextEncoder();

// What host.exit throws, to leave the program's code.
class Exit {
  constructor(code) {
    this.code = code;
  }
}

// path completed from directory cwd, with its . and .. segments resolved.
export function resolvePath(cwd, path) {
  const out = [];
  for (const seg of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

// The files of a pack, bytes (host/web/pack.mjs), put in files, their
// paths completed from dir: each is its path's length, the path, its
// length and its bytes, the lengths 32 bits, little-endian.
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

// Text written a piece at a time, given to line a line at a time.
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
  const cwd = options.cwd || '/';
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

  const out = lines((l) => console.log(l));
  const err = lines((l) => console.error(l));
  const write = options.write || ((fd, piece) => (fd === 2 ? err : out)(piece));
  // The decoders keep the bytes of a character that a write ends within.
  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };

  const app = { files, entry: null, ended: false };
  const modules = new Map();
  for (const [name, make] of Object.entries(options.modules || {})) modules.set(name, (caller) => make(caller, app));

  const host = createHost({
    args: options.args || [],
    write(fd, bytes) {
      write(fd, decoders[fd].decode(bytes, { stream: true }));
    },
    readFile(path) {
      const bytes = files.get(resolvePath(cwd, path));
      if (!bytes) throw new Error('No such file or directory');
      return bytes;
    },
    writeFile(path, bytes) {
      files.set(resolvePath(cwd, path), bytes);
    },
    exit(code) {
      throw new Exit(code);
    },
    modules,
  });
  app.host = host;

  // f, the program's code, run: false if it ended the program.
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
  const report = (message) => write(2, `error: ${message}\n`);

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
  app.call('main');
  return app;
}
