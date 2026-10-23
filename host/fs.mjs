// The host module "fs": files by path. node/fs.mjs and web/fs.mjs each give their files; a worker's are bounded
// by the directories its spec names.
// read_file(path, buf, cap): the size, and up to cap bytes; -1 if missing. write_file, make_dir, remove, rename:
// 0, or -1. stat: the size, -1 if missing, -2 for a directory. list: the names, each ended by a zero. open gives a stream;
// its modes: read 0, write 1, append 2.
import { joined } from './entries.mjs';

const utf8 = new TextEncoder();

export const isUnder = (dir, path) => path === dir || path.startsWith(dir === '/' ? dir : `${dir}/`);

// Whether a resolved path lies in one of the directories; no directories means anywhere.
export const within = (dirs, path) => !dirs || dirs.some((dir) => isUnder(dir, path));

export function fsModule(files, bounds = {}) {
  const inside = (dirs, path) => !dirs || within(dirs, files.resolve(path));
  const module = (caller) => {
    const attempt = (path, f) => {
      try {
        return f();
      } catch (e) {
        caller.error(`${path}: ${e.message}`);
        return -1;
      }
    };
    const readable = (path) => {
      if (!inside(bounds.read, path)) throw new Error('No such file or directory');
      return path;
    };
    const writable = (path) => {
      if (!inside(bounds.write, path)) throw new Error('Permission denied');
      return path;
    };
    const give = (bytes, buf, cap) => {
      caller.memory().set(bytes.subarray(0, cap), caller.u(buf));
      return bytes.length;
    };
    return {
      read_file(pp, pl, buf, cap) {
        const path = caller.string(pp, pl);
        return attempt(path, () => give(files.read(readable(path)), buf, cap));
      },
      write_file(pp, pl, ptr, len) {
        const path = caller.string(pp, pl);
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
        return attempt(path, () => (files.write(writable(path), bytes), 0));
      },
      make_dir(pp, pl) {
        const path = caller.string(pp, pl);
        return attempt(path, () => (files.makeDir(writable(path)), 0));
      },
      stat(pp, pl) {
        const path = caller.string(pp, pl);
        return BigInt(attempt(path, () => files.stat(readable(path))));
      },
      list(pp, pl, buf, cap) {
        const path = caller.string(pp, pl);
        return attempt(path, () => give(utf8.encode(joined(files.list(readable(path)))), buf, cap));
      },
      remove(pp, pl) {
        const path = caller.string(pp, pl);
        return attempt(path, () => (files.remove(writable(path)), 0));
      },
      rename(fp, fl, tp, tl) {
        const from = caller.string(fp, fl);
        const to = caller.string(tp, tl);
        return attempt(from, () => (files.rename(writable(from), writable(to)), 0));
      },
      open(pp, pl, mode, tag) {
        const path = caller.string(pp, pl);
        try {
          return caller.streams.add(tag, files.open(mode === 0 ? readable(path) : writable(path), mode));
        } catch (e) {
          caller.error(`${path}: ${e.message}`);
          return 0;
        }
      },
    };
  };
  module.bounds = bounds;
  return module;
}
