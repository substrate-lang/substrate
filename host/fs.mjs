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
      info(pp, pl, follow, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => files.info(path, follow !== 0), [0, 0, 0, 0]);
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
      open(pp, pl, mode, tag, err) {
        const path = caller.string(pp, pl);
        return attempt(path, err, () => caller.streams.add(tag, files.open(path, mode)), 0);
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
