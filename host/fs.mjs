// The host module "fs" (fs.sub), over the files that node/fs.mjs or web/fs.mjs gives.
import { joined } from './entries.mjs';

const utf8 = new TextEncoder();

// tempName gives prefix, 16 random hexadecimal digits and suffix, as Deno names a temporary file or directory.
export function tempName(prefix, suffix) {
  for (const part of [prefix, suffix]) {
    const bad = /[\p{Cc}<>:"/\\|?*]/u.exec(part);
    if (bad) throw new Error(`a temporary name cannot hold ${JSON.stringify(bad[0])}`);
  }
  const digits = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0'));
  return `${prefix}${digits.join('')}${suffix}`;
}

export const sameFile = () => new Error('the source and target are the same file');

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
    const handles = new Map();
    let next = 1;
    const using = (h, err, f, failed = -1) => {
      const open = handles.get(h);
      if (open) return attempt(open.path, err, () => f(open.file), failed);
      caller.fail(err, `file ${h}: Bad file descriptor`);
      return failed;
    };
    const bytesAt = (ptr, len) => caller.memory().subarray(caller.u(ptr), caller.u(ptr) + len);
    return {
      make_dir(pp, pl, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => (files.makeDir(path), 0));
      },
      info(pp, pl, follow, err) {
        const path = caller.string(pp, pl);
        const r = attempt(path, err, () => files.info(path, follow !== 0), [0, 0, 0, 0]);
        if (r !== null) return r;
        if (err !== 0) attempt(path, err, () => files.info(path, follow !== 0, true));
        return [0, 0, 0, 0];
      },
      list(pp, pl, out, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => caller.give(utf8.encode(joined(files.list(path))), out), 0);
      },
      remove(pp, pl, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => (files.remove(path, false), 0));
      },
      remove_all(pp, pl, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => (files.remove(path, true), 0));
      },
      rename(fp, fl, tp, tl, err) {
        const from = caller.string(fp, fl);
        const to = caller.string(tp, tl);
        return attempt(from, err, () => (files.rename(from, to), 0));
      },
      open_file(pp, pl, flags, err) {
        const path = caller.string(pp, pl);
        const write = (flags & 2) !== 0;
        const append = (flags & 4) !== 0;
        const how = {
          read: (flags & 1) !== 0 || !(write || append), write, append, truncate: (flags & 8) !== 0,
          create: (flags & 16) !== 0, createNew: (flags & 32) !== 0,
        };
        return attempt(path, err, () => {
          const file = files.openFile(path, how);
          handles.set(next, { path, file });
          return next++;
        }, 0);
      },
      file_stream(h, write, start, tag, err) {
        const open = handles.get(h);
        if (!open) {
          caller.fail(err, `file ${h}: Bad file descriptor`);
          return 0;
        }
        handles.delete(h);
        try {
          return caller.streams.add(tag, open.file.stream(start, write !== 0));
        } catch (e) {
          if (e instanceof WebAssembly.RuntimeError) throw e;
          attempt(open.path, 0, () => open.file.close());
          caller.fail(err, `${open.path}: ${e.message}`);
          return 0;
        }
      },
      read_at: (h, ptr, len, at, err) => using(h, err, (file) => file.read(bytesAt(ptr, len), at)),
      write_at: (h, ptr, len, at, err) => using(h, err, (file) => (file.write(bytesAt(ptr, len), at), 0)),
      set_file_size: (h, size, err) => using(h, err, (file) => (file.setSize(size), 0)),
      sync_file: (h, err) => using(h, err, (file) => (file.sync(), 0)),
      file_size: (h, err) => using(h, err, (file) => file.size()),
      close_file(h, err) {
        const r = using(h, err, (file) => (file.close(), 0));
        handles.delete(h);
        return r;
      },
      read_link(pp, pl, out, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => caller.give(utf8.encode(files.readLink(path)), out), 0);
      },
      real_path(pp, pl, out, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => caller.give(utf8.encode(files.realPath(path)), out), 0);
      },
      symlink(tp, tl, pp, pl, err) {
        const target = caller.string(tp, tl);
        const path = caller.string(pp, pl);
        return attempt(path, err, () => (files.symlink(target, path), 0));
      },
      copy_file(fp, fl, tp, tl, err) {
        const from = caller.string(fp, fl);
        const to = caller.string(tp, tl);
        return attempt(from, err, () => (files.copy(from, to), 0));
      },
      chmod(pp, pl, mode, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => (files.chmod(path, mode >>> 0), 0));
      },
      make_temp(dp, dl, xp, xl, sp, sl, file, out, err) {
        const dir = dl === 0 ? null : caller.string(dp, dl);
        const made = () => files.makeTemp(dir, caller.string(xp, xl), caller.string(sp, sl), file !== 0);
        return attempt(dir ?? 'the temporary directory', err, () => caller.give(utf8.encode(made()), out), 0);
      },
      cwd(out, err) {
        return attempt('.', err, () => caller.give(utf8.encode(files.cwd()), out), 0);
      },
    };
  };
}
