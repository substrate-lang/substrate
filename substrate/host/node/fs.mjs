// Node's file system, for fs.mjs, within the grants.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeSource } from '../streams.mjs';
import { allowsAll, mayPath, mayTree, notGranted, pathDenied, under, unlimited } from '../grants.mjs';
import { sameFile, tempName } from '../fs.mjs';

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_NOFOLLOW } = fs.constants;
const windows = process.platform === 'win32';

export function plainMessage(e) {
  if (typeof e.errno !== 'number') return e.message;
  const m = e.message.replace(/^[A-Z]+: /, '').replace(/, [a-z]+( '.*)?$/, '');
  return m.charAt(0).toUpperCase() + m.slice(1);
}

const plain = (f) => (...args) => {
  try {
    return f(...args);
  } catch (e) {
    if (typeof e.errno !== 'number') throw e;
    throw Object.assign(new Error(plainMessage(e)), { code: e.code });
  }
};

// comparable gives a path as Deno compares paths, which on macOS is in one Unicode form and case, and on Windows in one
// case, with slashes.
export const comparable = process.platform === 'darwin'
  ? (p) => p.normalize('NFKD').toUpperCase().toLowerCase()
  : windows ? (p) => p.replace(/\\/g, '/').toLowerCase() : (p) => p;

// realPath gives an absolute path with its links followed; of a path that does not exist yet, it follows the part
// that does.
export function realPath(abs) {
  try {
    return fs.realpathSync.native(abs);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
}

// programFile gives the file a program runs, found as spawn finds it: from dir for a name with a slash, and otherwise
// in the first directory of search with an executable file of that name; it gives null when there is none. On Windows,
// as libuv finds it: the name, if it has an extension, then the name with .com and with .exe.
export function programFile(name, dir = '.', search = process.env.PATH ?? '') {
  const names = windows ? [...(path.extname(name) ? [name] : []), `${name}.com`, `${name}.exe`] : [name];
  const found = (d) => names.map((m) => path.resolve(dir, d, m)).find((p) => {
    try {
      if (!fs.statSync(p).isFile()) return false;
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR' && e.code !== 'EACCES') throw e;
      return false;
    }
  });
  if (name.includes('/') || (windows && name.includes('\\'))) return (windows && found('')) || path.resolve(dir, name);
  for (const d of search.split(path.delimiter)) {
    const p = found(d);
    if (p) return p;
  }
  return null;
}

// resolveGrant gives a granted path or program as the host compares them.
export const resolveGrant = (text, k) => {
  const p = k === 'run' ? programFile(text) : path.resolve(text);
  return p === null ? null : comparable(p);
};

// Deno's rules for /dev, and on Linux /proc and /sys: the four devices any program may use, /dev/tty for reading,
// /proc/pressure, a pipe the host was given as /dev/fd/N or /proc/self/fd/N past 2, an environ file with all of -E, and
// anything else there with -A. On Windows, a path that starts with \\ but is not \\?\ and a drive needs -A, and \\.\nul
// does not.
const linux = process.platform === 'linux';
const devices = new Set(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom']);
const special = windows ? (p) => p.startsWith('\\\\') && !/^\\\\\?\\[A-Za-z]:\\/.test(p)
  : linux ? (p) => under(p, '/dev') || under(p, '/proc') || under(p, '/sys')
  : (p) => under(p, '/dev');
const pipe = (p) => {
  const fd = /^\/(?:dev\/fd|proc\/self\/fd)\/(\d+)$/.exec(p);
  if (fd === null || Number(fd[1]) <= 2) return false;
  try {
    return fs.fstatSync(Number(fd[1])).isFIFO();
  } catch {
    return false;
  }
};
const usable = windows ? (p) => p.toLowerCase() === '\\\\.\\nul'
  : (p, k) => devices.has(p) || (p === '/dev/tty' && k === 'read') || under(p, '/proc/pressure') || pipe(p);
// refusal gives the flag a special path needs, or null when it may be used.
const refusal = (grants, p, k) => {
  if (!special(p) || usable(p, k)) return null;
  if (linux && p.endsWith('/environ')) return unlimited(grants.env) ? null : '--allow-env';
  return '--allow-all';
};
const unresolved = windows ? (p) => p.startsWith('\\\\.\\')
  : linux ? (p) => under(p, '/proc') || under(p, '/dev') : () => false;
const missing = () => Object.assign(new Error('ENOENT: no such file or directory'), { errno: -2, code: 'ENOENT' });
const infoOf = (s) => [s.isFile() ? 1 : s.isDirectory() ? 2 : s.isSymbolicLink() ? 3 : 4, s.size, s.mtimeMs, s.mode];

// literalPath gives p absolute, checked as a call that does not follow its links is.
export function literalPath(grants, k, p) {
  const abs = path.resolve(p);
  if (allowsAll(grants)) return abs;
  if (!mayPath(grants[k], comparable(abs))) throw pathDenied(k);
  const flag = refusal(grants, abs, k);
  if (flag !== null) throw pathDenied(k, flag);
  return abs;
}

// A path as given is kept with its absolute form and the form the grants compare (key).
export function nodeFiles(grants) {
  const everything = () => allowsAll(grants);
  const known = new Map();
  let last = { p: null };
  const allowed = (k, p, tree = false) => {
    let hit = last.p === p ? last : known.get(p);
    if (hit === undefined) {
      const abs = path.resolve(p);
      hit = { p, abs, key: comparable(abs) };
      if (known.size >= 4096) known.clear();
      known.set(p, hit);
    }
    last = hit;
    if (!(tree ? mayTree : mayPath)(grants[k], hit.key)) throw pathDenied(k);
    return hit.abs;
  };
  const checked = (k, p) => {
    const flag = refusal(grants, p, k);
    if (flag !== null) throw pathDenied(k, flag);
    return p;
  };
  // at gives the path a call that does not follow links works on, checked as Deno checks it.
  const at = (k, p) => (everything() ? p : checked(k, allowed(k, p)));
  // opening gives open(where, flag) for where the links of p lead now, checked and opened without following a link
  // at its end, which is reported as missing, as Deno opens a path; on Linux, Deno leaves /proc and /dev unresolved.
  const opening = (k, p, flag, open) => {
    const abs = allowed(k, p);
    if (unresolved(abs)) return open(checked(k, abs), flag);
    const where = checked(k, realPath(abs));
    if (windows && fs.lstatSync(where, { throwIfNoEntry: false })?.isSymbolicLink()) throw missing();
    try {
      return open(where, flag | O_NOFOLLOW);
    } catch (e) {
      throw e.code === 'ELOOP' ? missing() : e;
    }
  };
  const resolved = (k, p) => {
    const abs = allowed(k, p);
    return checked(k, unresolved(abs) ? abs : realPath(abs));
  };
  return {
    makeDir: plain((p) => fs.mkdirSync(at('write', p), { recursive: true })),
    info: plain((p, follow, why) => {
      const s = (follow ? fs.statSync : fs.lstatSync)(at('read', p), { throwIfNoEntry: why === true });
      return s === undefined ? null : infoOf(s);
    }),
    list: plain((p) => fs.readdirSync(at('read', p)).sort()),
    remove: plain((p, recursive) => {
      const where = everything() ? p : allowed('write', p, recursive);
      if (!fs.lstatSync(where).isDirectory()) fs.unlinkSync(where);
      else if (recursive) fs.rmSync(where, { recursive: true });
      else fs.rmdirSync(where);
    }),
    readLink: plain((p) => fs.readlinkSync(at('read', p))),
    realPath: plain((p) => fs.realpathSync.native(at('read', p))),
    symlink: plain((target, p) => {
      if (!(unlimited(grants.read) && unlimited(grants.write))) {
        throw notGranted('making a link is not granted (all of --allow-read and --allow-write)');
      }
      fs.symlinkSync(target, p);
    }),
    copy: plain((from, to) => {
      const source = everything() ? from : resolved('read', from);
      const target = at('write', to);
      try {
        const [a, b] = [fs.statSync(source), fs.statSync(target)];
        if (a.dev === b.dev && a.ino === b.ino) throw sameFile();
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      fs.copyFileSync(source, target);
    }),
    chmod: plain((p, mode) => fs.chmodSync(at('write', p), mode)),
    makeTemp: plain((dir, prefix, suffix, file) => {
      const base = dir ?? os.tmpdir();
      if (!everything()) checked('write', allowed('write', base));
      for (let tries = 0; tries < 10; tries++) {
        const name = tempName(prefix, suffix);
        const made = path.join(base, name);
        try {
          if (file) fs.closeSync(fs.openSync(made, 'wx', 0o600));
          else fs.mkdirSync(made, { mode: 0o700 });
          return dir === null ? made : `${dir.replace(/\/$/, '')}/${name}`;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
      }
      throw new Error(`too many temporary ${file ? 'files' : 'directories'} exist`);
    }),
    cwd: plain(() => process.cwd()),
    rename: plain((from, to) => {
      at('read', from);
      fs.renameSync(at('write', from), at('write', to));
    }),
    openFile: plain((p, how) => {
      const writes = how.write || how.append;
      const changes = writes || how.truncate || how.create || how.createNew;
      const truncateOpen = windows && how.truncate && !how.create && !how.createNew;
      const flag = (how.read ? (writes ? O_RDWR : O_RDONLY) : O_WRONLY) | (how.append ? O_APPEND : 0)
        | (how.truncate && !truncateOpen ? O_TRUNC : 0) | (how.create || how.createNew ? O_CREAT : 0)
        | (how.createNew ? O_EXCL : 0);
      if (how.read && changes && !everything()) allowed('read', p);
      const fd = everything() ? fs.openSync(p, flag) : opening(changes ? 'write' : 'read', p, flag, fs.openSync);
      if (truncateOpen) fs.ftruncateSync(fd, 0);
      const kind = fs.fstatSync(fd);
      const seekable = kind.isFile() || kind.isBlockDevice();
      return {
        read: plain((bytes, at) => {
          let n = 0;
          while (n < bytes.length) {
            const got = fs.readSync(fd, bytes, n, bytes.length - n, seekable ? at + n : null);
            if (got === 0) break;
            n += got;
          }
          return n;
        }),
        write: plain((bytes, at) => {
          let n = 0;
          while (n < bytes.length) {
            n += fs.writeSync(fd, bytes, n, bytes.length - n, seekable && !how.append ? at + n : null);
          }
        }),
        setSize: plain((n) => fs.ftruncateSync(fd, n)),
        sync: plain(() => fs.fsyncSync(fd)),
        size: plain(() => fs.fstatSync(fd).size),
        close: plain(() => fs.closeSync(fd)),
        stream: (start, write) => nodeSource(write
          ? fs.createWriteStream('', { fd, start: seekable && !how.append ? start : undefined })
          : fs.createReadStream('', { fd, start: seekable ? start : undefined })),
      };
    }),
  };
}
