// The host module "fs": files by path. node/fs.mjs and web/fs.mjs each give their files.
// read_file and list give their bytes as host.arg does, 0 if missing: the file's, or the names, each ended by a
// zero. write_file, make_dir, remove, rename: 0, or -1. stat: the size, -1 if missing, -2 for a directory. open
// gives a stream; its modes: read 0, write 1, append 2. Each puts a failure's reason at err, as host.instantiate does.
import { joined } from './entries.mjs';

const utf8 = new TextEncoder();

export function fsModule(files) {
  return (caller) => {
    const attempt = (path, err, f, failed = -1) => {
      try {
        return f();
      } catch (e) {
        if (e instanceof WebAssembly.RuntimeError) throw e;
        caller.fail(err, `${path}: ${e.message}`);
        return failed;
      }
    };
    return {
      read_file(pp, pl, out, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => caller.give(files.read(path), out), 0);
      },
      write_file(pp, pl, ptr, len, err) {
        const path = caller.string(pp, pl);
        const bytes = caller.memory().slice(caller.u(ptr), caller.u(ptr) + len);
        return attempt(path, err, () => (files.write(path, bytes), 0));
      },
      make_dir(pp, pl, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => (files.makeDir(path), 0));
      },
      stat(pp, pl, err) {
        const path = caller.string(pp, pl);
        return BigInt(attempt(path, err, () => files.stat(path)));
      },
      list(pp, pl, out, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => caller.give(utf8.encode(joined(files.list(path))), out), 0);
      },
      remove(pp, pl, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => (files.remove(path), 0));
      },
      rename(fp, fl, tp, tl, err) {
        const from = caller.string(fp, fl);
        const to = caller.string(tp, tl);
        return attempt(from, err, () => (files.rename(from, to), 0));
      },
      open(pp, pl, mode, tag, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => caller.streams.add(tag, files.open(path, mode)), 0);
      },
    };
  };
}
