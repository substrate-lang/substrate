// A page's files, for fs.mjs: in memory, under the program's working directory.
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

export function pageFiles(files, cwd) {
  const at = (p) => resolvePath(cwd, p);
  const read = (p) => {
    const bytes = files.get(at(p));
    if (!bytes) throw missing();
    return bytes;
  };
  return {
    read,
    write(p, bytes) {
      files.set(at(p), bytes);
    },
    makeDir() {},
    stat(p) {
      const key = at(p);
      if (files.has(key)) return files.get(key).length;
      for (const k of files.keys()) if (k.startsWith(under(key))) return -2;
      throw missing();
    },
    list(p) {
      const prefix = under(at(p));
      const names = new Set();
      for (const k of files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
      if (names.size === 0) throw missing();
      return [...names].sort();
    },
    remove(p) {
      if (!files.delete(at(p))) throw missing();
    },
    rename(from, to) {
      const bytes = read(from);
      files.delete(at(from));
      files.set(at(to), bytes);
    },
    open(p, mode) {
      const key = at(p);
      if (mode === 0) {
        const bytes = read(p);
        let given = false;
        return { pull: async () => (given ? null : ((given = true), bytes)), close() {} };
      }
      const chunks = mode === 2 && files.has(key) ? [files.get(key)] : [];
      const keep = () => files.set(key, concat(chunks));
      const source = {
        write(bytes) {
          chunks.push(bytes);
          return true;
        },
        finish() {
          keep();
          source.finished();
        },
        close: keep,
      };
      return source;
    },
  };
}
