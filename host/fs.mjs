// The host module "fs" (fs.sub), over the files that node/fs.mjs or web/fs.mjs gives.
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
