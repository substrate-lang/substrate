// A web program's files for fs.mjs, kept in memory under the program's working directory and checked against the
// program's grants. A directory exists as long as it has a file in it, and there are no links or modes.
import { mayPath, mayTree, pathDenied, unlimited } from '../grants.mjs';
import { sameFile, tempName } from '../fs.mjs';

export function resolvePath(cwd, path) {
  const out = [];
  for (const seg of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

const missing = () => Object.assign(new Error('No such file or directory'), { code: 'ENOENT' });
const unsupported = () => new Error('Operation not supported');
const under = (dir) => (dir === '/' ? '/' : `${dir}/`);

export function memoryFiles(files, cwd, grants) {
  const times = new Map();
  const at = (k, p, tree = false) => {
    const key = resolvePath(cwd, p);
    if (!unlimited(grants[k]) && !(tree ? mayTree : mayPath)(grants[k], key)) throw pathDenied(k);
    return key;
  };
  const read = (p) => {
    const bytes = files.get(at('read', p));
    if (!bytes) throw missing();
    return bytes;
  };
  const keep = (key, bytes) => {
    files.set(key, bytes);
    times.set(key, Date.now());
  };
  const inside = (key) => [...files.keys()].filter((k) => k.startsWith(under(key)));
  // The buffers open files write into, one each.
  const owned = new WeakSet();
  const content = (key) => files.get(key) ?? new Uint8Array(0);
  const resized = (key, n) => {
    const bytes = content(key);
    let view;
    if (owned.has(bytes.buffer) && n <= bytes.buffer.byteLength) {
      if (n < bytes.length) bytes.fill(0, n);
      view = new Uint8Array(bytes.buffer, 0, n);
    } else {
      view = new Uint8Array(Math.max(n, 2 * bytes.length)).subarray(0, n);
      view.set(n < bytes.length ? bytes.subarray(0, n) : bytes);
      owned.add(view.buffer);
    }
    keep(key, view);
    return view;
  };
  const found = (key) => {
    if (files.has(key)) return [1, files.get(key).length, times.get(key) ?? 0, 0];
    if (inside(key).length > 0) return [2, 0, 0, 0];
    return null;
  };
  const info = (key) => {
    const r = found(key);
    if (r === null) throw missing();
    return r;
  };
  const opened = (key, how) => {
    const writes = how.write || how.append;
    const readable = () => {
      if (!how.read) throw new Error('Bad file descriptor');
    };
    const writable = () => {
      if (!writes) throw new Error('Bad file descriptor');
    };
    const file = {
      read(bytes, from) {
        readable();
        const all = content(key);
        const n = Math.max(0, Math.min(bytes.length, all.length - from));
        bytes.set(all.subarray(from, from + n));
        return n;
      },
      write(bytes, from) {
        writable();
        const at = how.append ? content(key).length : from;
        resized(key, Math.max(at + bytes.length, content(key).length)).set(bytes, at);
      },
      setSize(n) {
        writable();
        resized(key, n);
      },
      sync() {},
      size: () => content(key).length,
      close() {},
      stream(start, write) {
        if (!write) {
          readable();
          let given = false;
          return { pull: async () => (given ? null : ((given = true), content(key).slice(start))), close() {} };
        }
        writable();
        let at = start;
        const source = {
          write(bytes) {
            file.write(bytes, at);
            at += bytes.length;
            return true;
          },
          finish() {
            source.finished();
          },
          close() {},
        };
        return source;
      },
    };
    return file;
  };
  return {
    makeDir(p) {
      at('write', p);
    },
    info: (p, follow, why) => (why === true ? info(at('read', p)) : found(at('read', p))),
    list(p) {
      const prefix = under(at('read', p));
      const names = new Set();
      for (const k of files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
      if (names.size === 0) throw missing();
      return [...names].sort();
    },
    remove(p, recursive) {
      const key = at('write', p, recursive);
      if (files.delete(key)) return;
      const keys = inside(key);
      if (keys.length === 0) throw missing();
      if (!recursive) throw new Error('Directory not empty');
      for (const k of keys) files.delete(k);
    },
    rename(from, to) {
      at('read', from);
      const bytes = files.get(at('write', from));
      if (!bytes) throw missing();
      files.delete(at('write', from));
      keep(at('write', to), bytes);
    },
    readLink(p) {
      info(at('read', p));
      throw Object.assign(new Error('Invalid argument'), { code: 'EINVAL' });
    },
    realPath(p) {
      const key = at('read', p);
      info(key);
      return key;
    },
    symlink() {
      throw unsupported();
    },
    copy(from, to) {
      const bytes = read(from);
      const target = at('write', to);
      if (target === resolvePath(cwd, from)) throw sameFile();
      keep(target, bytes.slice());
    },
    chmod(p) {
      info(at('write', p));
      throw unsupported();
    },
    makeTemp(dir, prefix, suffix, file) {
      const base = dir === null ? '/tmp' : dir.replace(/\/$/, '');
      at('write', base);
      for (let tries = 0; tries < 10; tries++) {
        const made = `${base}/${tempName(prefix, suffix)}`;
        const key = resolvePath(cwd, made);
        if (files.has(key) || inside(key).length > 0) continue;
        if (file) keep(key, new Uint8Array(0));
        return made;
      }
      throw new Error(`too many temporary ${file ? 'files' : 'directories'} exist`);
    },
    cwd: () => cwd,
    openFile(p, how) {
      const changes = how.write || how.append || how.truncate || how.create || how.createNew;
      const key = at(changes ? 'write' : 'read', p);
      if (how.read && changes) at('read', p);
      if (files.has(key)) {
        if (how.createNew) throw Object.assign(new Error('File already exists'), { code: 'EEXIST' });
      } else if (inside(key).length > 0) {
        throw new Error('Illegal operation on a directory');
      } else if (how.create || how.createNew) {
        keep(key, new Uint8Array(0));
      } else {
        throw missing();
      }
      if (how.truncate) resized(key, 0);
      return opened(key, how);
    },
  };
}
