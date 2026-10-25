// Node's file system, for fs.mjs, within the grants.
import fs from 'node:fs';
import path from 'node:path';
import { nodeSource } from '../streams.mjs';
import { allowsAll, mayPath, pathDenied, under, unlimited } from '../grants.mjs';

const modes = { 0: 'r', 1: 'w', 2: 'a' };

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
export const comparable = process.platform === 'darwin' ? (p) => p.normalize('NFKD').toLowerCase() : (p) => p;

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

// Deno's rules for /dev, /proc and /sys: the four devices any program may use, a pipe the host was given as
// /dev/fd/N or /proc/self/fd/N past 2, a process's environ with all of -E, and anything else there with -A.
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
const specialDenied = (grants, p, k) => {
  if (devices.has(p) || pipe(p)) return null;
  if (under(p, '/proc') && p.endsWith('/environ')) return unlimited(grants.env) ? null : pathDenied(k, '--allow-env');
  return pathDenied(k, '--allow-all');
};

// A path as given is kept with its absolute form, which the grants compare (key), and where its links lead (real),
// until the program renames or removes a file in any of its threads, which add to changes.
export function nodeFiles(grants, changes) {
  const everything = allowsAll(grants);
  const known = new Map();
  let last = { p: null, seen: -1 };
  const at = (p, follow) => {
    const seen = Atomics.load(changes, 0);
    let hit = last.p === p && last.seen === seen ? last : known.get(p);
    if (hit === undefined || hit.seen !== seen) {
      const abs = path.resolve(p);
      hit = { p, seen, abs, key: comparable(abs), real: null };
      if (known.size >= 4096) known.clear();
      known.set(p, hit);
    }
    if (follow && hit.real === null) hit.real = special(hit.abs) ? hit.abs : realPath(hit.abs);
    last = hit;
    return hit;
  };
  const allowed = (k, p, follow) => {
    const found = at(p, follow);
    if (!mayPath(grants[k], found.key)) throw pathDenied(k);
    return found;
  };
  // opened checks a path as the calls that open it do, following its links when follow is set.
  const opened = (k, p, follow = true) => {
    if (everything) return p;
    const found = allowed(k, p, follow);
    const checked = follow ? found.real : found.abs;
    if (special(checked)) {
      const why = specialDenied(grants, checked, k);
      if (why !== null) throw why;
    }
    return found.abs;
  };
  const changing = (f) => (...args) => {
    try {
      return f(...args);
    } finally {
      Atomics.add(changes, 0, 1);
    }
  };
  return {
    read: plain((p) => fs.readFileSync(opened('read', p))),
    write: plain((p, bytes) => fs.writeFileSync(opened('write', p), bytes)),
    makeDir: plain((p) => fs.mkdirSync(opened('write', p, false), { recursive: true })),
    stat: plain((p) => {
      const s = fs.statSync(opened('read', p, false));
      return s.isDirectory() ? -2 : s.size;
    }),
    list: plain((p) => fs.readdirSync(opened('read', p, false)).sort()),
    remove: plain(changing((p) => fs.rmSync(everything ? p : allowed('write', p, false).abs))),
    rename: plain(changing((from, to) => {
      opened('read', from, false);
      fs.renameSync(opened('write', from, false), opened('write', to, false));
    })),
    open: plain((p, mode) => {
      const fd = fs.openSync(opened(mode === 0 ? 'read' : 'write', p), modes[mode] || 'r');
      return nodeSource(mode === 0 ? fs.createReadStream('', { fd }) : fs.createWriteStream('', { fd }));
    }),
  };
}
