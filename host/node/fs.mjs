// Node's file system, for fs.mjs, within the grants.
import fs from 'node:fs';
import { nodeSource } from '../streams.mjs';
import { mayPath, pathDenied, unlimited } from '../grants.mjs';

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

// realPath gives p absolute with its symbolic links followed, the last one too unless follow is false. Of a path
// that does not exist yet, it follows the part that does; it gives null for a missing one that ends in . or ..
export function realPath(p, follow = true) {
  const abs = p.startsWith('/') ? p : `${process.cwd()}/${p}`;
  const trimmed = abs.length > 1 ? abs.replace(/\/+$/, '') || '/' : abs;
  const slash = trimmed.lastIndexOf('/');
  const base = trimmed.slice(slash + 1);
  const dots = base === '.' || base === '..';
  if (follow || dots || trimmed === '/') {
    try {
      return fs.realpathSync.native(trimmed);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      if (dots) return null;
    }
  }
  const parent = realPath(slash === 0 ? '/' : trimmed.slice(0, slash));
  return parent === null ? null : `${parent === '/' ? '' : parent}/${base}`;
}

export function nodeFiles(grants) {
  const checked = (k, p, follow = true) => {
    if (unlimited(grants[k])) return p;
    const real = realPath(p, follow);
    if (real === null) throw new Error('No such file or directory');
    if (!mayPath(grants[k], real)) throw pathDenied(k);
    return real;
  };
  return {
    read: plain((p) => fs.readFileSync(checked('read', p))),
    write: plain((p, bytes) => fs.writeFileSync(checked('write', p), bytes)),
    makeDir: plain((p) => fs.mkdirSync(checked('write', p), { recursive: true })),
    stat: plain((p) => {
      const s = fs.statSync(checked('read', p));
      return s.isDirectory() ? -2 : s.size;
    }),
    list: plain((p) => fs.readdirSync(checked('read', p)).sort()),
    remove: plain((p) => fs.rmSync(checked('write', p, false))),
    rename: plain((from, to) => fs.renameSync(checked('write', from, false), checked('write', to, false))),
    open: plain((p, mode) => {
      const fd = fs.openSync(checked(mode === 0 ? 'read' : 'write', p), modes[mode] || 'r');
      return nodeSource(mode === 0 ? fs.createReadStream('', { fd }) : fs.createWriteStream('', { fd }));
    }),
  };
}
