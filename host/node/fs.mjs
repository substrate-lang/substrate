// The host module "fs": the file system beside host.read_file, write_file and make_dir; open gives a stream.
// stat: the size, -1 if missing, -2 for a directory. open's modes: read 0, write 1, append 2.
import fs from 'node:fs';
import { nodeSource } from '../streams.mjs';

const utf8 = new TextEncoder();

const modes = { 0: 'r', 1: 'w', 2: 'a' };

export function fsModule() {
  return (caller) => {
    const attempt = (f) => {
      try {
        return f();
      } catch (e) {
        caller.error(e.message);
        return -1;
      }
    };
    return {
      stat(ptr, len) {
        const path = caller.string(ptr, len);
        try {
          const s = fs.statSync(path);
          return s.isDirectory() ? -2n : BigInt(s.size);
        } catch (e) {
          caller.error(e.message);
          return -1n;
        }
      },
      list(ptr, len, buf, cap) {
        return attempt(() => {
          const bytes = utf8.encode(fs.readdirSync(caller.string(ptr, len)).sort().map((n) => `${n}\n`).join(''));
          caller.memory().set(bytes.subarray(0, cap), caller.u(buf));
          return bytes.length;
        });
      },
      remove(ptr, len) {
        return attempt(() => {
          fs.rmSync(caller.string(ptr, len));
          return 0;
        });
      },
      rename(fromPtr, fromLen, toPtr, toLen) {
        return attempt(() => {
          fs.renameSync(caller.string(fromPtr, fromLen), caller.string(toPtr, toLen));
          return 0;
        });
      },
      open(ptr, len, mode, tag) {
        let fd;
        try {
          fd = fs.openSync(caller.string(ptr, len), modes[mode] || 'r');
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
        const stream = mode === 0 ? fs.createReadStream('', { fd }) : fs.createWriteStream('', { fd });
        return caller.streams.add(tag, nodeSource(stream));
      },
    };
  };
}
