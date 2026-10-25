// Node's file system, for fs.mjs, within the grants.
import fs from 'node:fs';
import path from 'node:path';
import { nodeSource } from '../streams.mjs';
import { allowsAll, mayPath, pathDenied, under } from '../grants.mjs';

const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_APPEND, O_NOFOLLOW } = fs.constants;
const modes = { 0: O_RDONLY, 1: O_WRONLY | O_CREAT | O_TRUNC, 2: O_WRONLY | O_CREAT | O_APPEND };

const plain = (f) => (...args) => {
  try {
    return f(...args);
  } catch (e) {
    if (typeof e.errno !== 'number') throw e;
    const m = e.message.replace(/^[A-Z]+: /, '').replace(/, [a-z]+ '.*$/, '');
    throw new Error(m.charAt(0).toUpperCase() + m.slice(1));
  }
};

// comparable gives a path as Deno compares paths, which on macOS is in one Unicode form and case.
export const comparable = process.platform === 'darwin'
  ? (p) => p.normalize('NFKD').toUpperCase().toLowerCase()
  : (p) => p;

// realPath gives an absolute path with its links followed; of a path that does not exist yet, it follows the part
// that does.
export function realPath(abs) {
  try {
    return fs.realpathSync.native(abs);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
  const slash = abs.lastIndexOf('/');
  const parent = realPath(slash === 0 ? '/' : abs.slice(0, slash));
  return `${parent === '/' ? '' : parent}/${abs.slice(slash + 1)}`;
}

// programFile gives the file a program runs, found as spawn finds it: from dir for a name with a slash, and otherwise
// in the first directory of search with an executable file of that name; it gives null when there is none.
export function programFile(name, dir = '.', search = process.env.PATH ?? '') {
  if (name.includes('/')) return path.resolve(dir, name);
  for (const d of search.split(':')) {
    const p = path.resolve(dir, d, name);
    try {
      if (fs.statSync(p).isFile()) {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      }
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR' && e.code !== 'EACCES') throw e;
    }
  }
  return null;
}

// resolveGrant gives a granted path or program as the host compares them.
export const resolveGrant = (text, k) => {
  const p = k === 'run' ? programFile(text) : path.resolve(text);
  return p === null ? null : comparable(p);
};

// Deno's rules for /dev, /proc and /sys: the four devices any program may use, /dev/tty for reading, /proc/pressure,
// a pipe the host was given as /dev/fd/N or /proc/self/fd/N past 2, and anything else there with -A.
const devices = new Set(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom']);
const special = (p) => under(p, '/dev') || under(p, '/proc') || under(p, '/sys');
const pipe = (p) => {
  const fd = /^\/(?:dev\/fd|proc\/self\/fd)\/(\d+)$/.exec(p);
  if (fd === null || Number(fd[1]) <= 2) return false;
  try {
    return fs.fstatSync(Number(fd[1])).isFIFO();
  } catch {
    return false;
  }
};
const usable = (p, k) => devices.has(p) || (p === '/dev/tty' && k === 'read') || under(p, '/proc/pressure') || pipe(p);
const unresolved = process.platform === 'linux' ? (p) => under(p, '/proc') || under(p, '/dev') : () => false;
const missing = () => Object.assign(new Error('ENOENT: no such file or directory'), { errno: -2, code: 'ENOENT' });
const readFile = (p, flag) => fs.readFileSync(p, { flag });

// A path as given is kept with its absolute form and the form the grants compare (key).
export function nodeFiles(grants) {
  const everything = allowsAll(grants);
  const known = new Map();
  let last = { p: null };
  const allowed = (k, p) => {
    let hit = last.p === p ? last : known.get(p);
    if (hit === undefined) {
      const abs = path.resolve(p);
      hit = { p, abs, key: comparable(abs) };
      if (known.size >= 4096) known.clear();
      known.set(p, hit);
    }
    last = hit;
    if (!mayPath(grants[k], hit.key)) throw pathDenied(k);
    return hit.abs;
  };
  const checked = (k, p) => {
    if (special(p) && !usable(p, k)) throw pathDenied(k, '--allow-all');
    return p;
  };
  // at gives the path a call that does not follow links works on, checked as Deno checks it.
  const at = (k, p) => (everything ? p : checked(k, allowed(k, p)));
  // opening gives open(where, flag) for where the links of p lead now, checked and opened without following a link
  // at its end, which is reported as missing, as Deno opens a path; on Linux, Deno leaves /proc and /dev unresolved.
  const opening = (k, p, flag, open) => {
    const abs = allowed(k, p);
    if (unresolved(abs)) return open(checked(k, abs), flag);
    const where = checked(k, realPath(abs));
    try {
      return open(where, flag | O_NOFOLLOW);
    } catch (e) {
      throw e.code === 'ELOOP' ? missing() : e;
    }
  };
  return {
    read: plain((p) => (everything ? fs.readFileSync(p) : opening('read', p, O_RDONLY, readFile))),
    write: plain((p, bytes) => (everything
      ? fs.writeFileSync(p, bytes)
      : opening('write', p, modes[1], (where, flag) => fs.writeFileSync(where, bytes, { flag })))),
    makeDir: plain((p) => fs.mkdirSync(at('write', p), { recursive: true })),
    stat: plain((p) => {
      const s = fs.statSync(at('read', p));
      return s.isDirectory() ? -2 : s.size;
    }),
    list: plain((p) => fs.readdirSync(at('read', p)).sort()),
    remove: plain((p) => fs.rmSync(everything ? p : allowed('write', p))),
    rename: plain((from, to) => {
      at('read', from);
      fs.renameSync(at('write', from), at('write', to));
    }),
    open: plain((p, mode) => {
      const flag = modes[mode] ?? O_RDONLY;
      const fd = everything ? fs.openSync(p, flag) : opening(mode === 0 ? 'read' : 'write', p, flag, fs.openSync);
      return nodeSource(mode === 0 ? fs.createReadStream('', { fd }) : fs.createWriteStream('', { fd }));
    }),
  };
}
