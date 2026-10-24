// Node's file system, for fs.mjs.
import fs from 'node:fs';
import { nodeSource } from '../streams.mjs';

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

export function nodeFiles() {
  return {
    read: plain((p) => fs.readFileSync(p)),
    write: plain((p, bytes) => fs.writeFileSync(p, bytes)),
    makeDir: plain((p) => fs.mkdirSync(p, { recursive: true })),
    stat: plain((p) => {
      const s = fs.statSync(p);
      return s.isDirectory() ? -2 : s.size;
    }),
    list: plain((p) => fs.readdirSync(p).sort()),
    remove: plain((p) => fs.rmSync(p)),
    rename: plain((from, to) => fs.renameSync(from, to)),
    open: plain((p, mode) => {
      const fd = fs.openSync(p, modes[mode] || 'r');
      return nodeSource(mode === 0 ? fs.createReadStream('', { fd }) : fs.createWriteStream('', { fd }));
    }),
  };
}
