// The host module "process" (process.sub).
import child from 'node:child_process';
import os from 'node:os';
import { errorOf, reasonOf } from '../errors.mjs';
import { nodeSource } from '../streams.mjs';
import { entries } from '../entries.mjs';

const utf8 = new TextEncoder();

const SOURCE = 10;
const EXIT = 1;
const FAILED = 2;

const pipes = ['stdin', 'stdout', 'stderr'];

export function processes(grants) {
  const children = new Map();
  let next = 1;
  return (caller) => {
    return {
      source: SOURCE,
      end() {
        for (const c of children.values()) c.process.kill();
        children.clear();
      },
      spawn(pp, pl, ap, al, dp, dl, ep, el, clear, stdin, stdout, stderr, tag, err) {
        if (!grants.run) {
          caller.fail(err, 'process.spawn: running programs is not granted (--allow-run)');
          return 0;
        }
        const modes = [stdin, stdout, stderr].map((mode) => ['pipe', 'ignore', 'inherit'][mode] || 'pipe');
        let process;
        try {
          const env = clear ? {} : { ...globalThis.process.env };
          for (const e of entries(caller.string(ep, el))) {
            const equals = e.indexOf('=');
            env[equals < 0 ? e : e.slice(0, equals)] = equals < 0 ? '' : e.slice(equals + 1);
          }
          process = child.spawn(caller.string(pp, pl), entries(caller.string(ap, al)), {
            cwd: caller.string(dp, dl) || undefined,
            env,
            stdio: modes,
          });
        } catch (e) {
          caller.fail(err, e.message);
          return 0;
        }
        const id = next++;
        const c = { process };
        pipes.forEach((pipe, i) => {
          c[pipe] = modes[i] === 'pipe' ? caller.streams.add(tag, nodeSource(process[pipe])) : 0;
        });
        children.set(id, c);
        process.on('error', (e) => {
          if (children.get(id) !== c) return;
          children.delete(id);
          caller.event(FAILED, id, tag, errorOf(e), utf8.encode(reasonOf(e)));
        });
        process.on('close', (code, signal) => {
          if (children.get(id) !== c) return;
          children.delete(id);
          caller.event(EXIT, id, tag, code !== null ? code : 128 + (os.constants.signals[signal] || 0));
        });
        return id;
      },
      stdin(id) {
        const c = children.get(id);
        return c ? c.stdin : 0;
      },
      stdout(id) {
        const c = children.get(id);
        return c ? c.stdout : 0;
      },
      stderr(id) {
        const c = children.get(id);
        return c ? c.stderr : 0;
      },
      kill(id, signal) {
        const c = children.get(id);
        if (c) c.process.kill(signal || 'SIGTERM');
      },
    };
  };
}
