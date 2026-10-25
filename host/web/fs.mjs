// A page's files for fs.mjs, kept in memory under the program's working directory, within the grants if given. A
// directory is there while a file is in it, and there are no links or modes.
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

const missing = () => new Error('No such file or directory');
const unsupported = () => new Error('Operation not supported');
const under = (dir) => (dir === '/' ? '/' : `${dir}/`);

function concat(chunks) {
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

export function pageFiles(files, cwd, grants) {
  const times = new Map();
  const at = (k, p, tree = false) => {
    const key = resolvePath(cwd, p);
    if (grants && !unlimited(grants[k]) && !(tree ? mayTree : mayPath)(grants[k], key)) throw pathDenied(k);
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
  const info = (key) => {
    if (files.has(key)) return [1, files.get(key).length, times.get(key) ?? 0, 0];
    if (inside(key).length > 0) return [2, 0, 0, 0];
    throw missing();
  };
  return {
    read,
    write(p, bytes) {
      keep(at('write', p), bytes);
    },
    makeDir(p) {
      at('write', p);
    },
    info: (p) => info(at('read', p)),
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
      throw new Error('Invalid argument');
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
      keep(target, bytes);
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
    open(p, mode) {
      if (mode === 0) {
        const bytes = read(p);
        let given = false;
        return { pull: async () => (given ? null : ((given = true), bytes)), close() {} };
      }
      const key = at('write', p);
      const chunks = mode === 2 && files.has(key) ? [files.get(key)] : [];
      const save = () => keep(key, concat(chunks));
      const source = {
        write(bytes) {
          chunks.push(bytes);
          return true;
        },
        finish() {
          save();
          source.finished();
        },
        close: save,
      };
      return source;
    },
  };
}
