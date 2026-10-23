// The host module "fs": files by path. node/fs.mjs and web/fs.mjs each give their files.
// read_file(path, buf, cap): the size, and up to cap bytes; -1 if missing. write_file, make_dir, remove, rename:
// 0, or -1. stat: the size, -1 if missing, -2 for a directory. list: the names, each ended by a zero. open gives a
// stream; its modes: read 0, write 1, append 2.
import { joined } from './entries.mjs';

const utf8 = new TextEncoder();

export function fsModule(files) {
  return (caller) => {
    const attempt = (path, f) => {
      try {
        return f();
      } catch (e) {
        caller.error(`${path}: ${e.message}`);
        return -1;
      }
    };
    const give = (bytes, buf, cap) => {
      caller.memory().set(bytes.subarray(0, cap), caller.u(buf));
      return bytes.length;
    };
    return {
      read_file(pp, pl, buf, cap) {
        const path = caller.string(pp, pl);
        return attempt(path, () => give(files.read(path), buf, cap));
      },
      write_file(pp, pl, ptr, len) {
        const path = caller.string(pp, pl);
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
        return attempt(path, () => (files.write(path, bytes), 0));
      },
      make_dir(pp, pl) {
        const path = caller.string(pp, pl);
        return attempt(path, () => (files.makeDir(path), 0));
      },
      stat(pp, pl) {
        const path = caller.string(pp, pl);
        return BigInt(attempt(path, () => files.stat(path)));
      },
      list(pp, pl, buf, cap) {
        const path = caller.string(pp, pl);
        return attempt(path, () => give(utf8.encode(joined(files.list(path))), buf, cap));
      },
      remove(pp, pl) {
        const path = caller.string(pp, pl);
        return attempt(path, () => (files.remove(path), 0));
      },
      rename(fp, fl, tp, tl) {
        const from = caller.string(fp, fl);
        const to = caller.string(tp, tl);
        return attempt(from, () => (files.rename(from, to), 0));
      },
      open(pp, pl, mode, tag) {
        const path = caller.string(pp, pl);
        try {
          return caller.streams.add(tag, files.open(path, mode));
        } catch (e) {
          caller.error(`${path}: ${e.message}`);
          return 0;
        }
      },
    };
  };
}
