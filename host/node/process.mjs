// The host module "process" (process.sub).
import child from 'node:child_process';
import os from 'node:os';
import { errorOf, reasonOf } from '../errors.mjs';
import { nodeSource } from '../streams.mjs';
import { entries } from '../entries.mjs';
import { isLoaderVariable, mayRun, notGranted, unlimited } from '../grants.mjs';
import { comparable, programFile } from './fs.mjs';

const utf8 = new TextEncoder();

const SOURCE = 10;
const EXIT = 1;
const FAILED = 2;

const pipes = ['stdin', 'stdout', 'stderr'];

// refuse throws unless the grant lets the program run, as the file found for it, with the dynamic loader's variables
// the host started with (loader).
function refuse(grant, file, program, env, loader) {
  if (!mayRun(grant, file === null ? null : comparable(file), program)) {
    throw notGranted(`process.spawn: ${program} is not granted (--allow-run)`);
  }
  const changed = Object.keys(env).filter((name) => isLoaderVariable(name) && env[name] !== ''
    && env[name] !== loader[name]);
  if (changed.length > 0) {
    throw notGranted(`process.spawn: changing ${changed.sort().join(', ')} for a program is not granted (--allow-run)`);
  }
}

export function processes(grants, loader) {
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
        const modes = [stdin, stdout, stderr].map((mode) => ['pipe', 'ignore', 'inherit'][mode] || 'pipe');
        let process;
        try {
          const program = caller.string(pp, pl);
          const cwd = caller.string(dp, dl) || undefined;
          const env = clear ? {} : { ...globalThis.process.env };
          for (const e of entries(caller.string(ep, el))) {
            const equals = e.indexOf('=');
            env[equals < 0 ? e : e.slice(0, equals)] = equals < 0 ? '' : e.slice(equals + 1);
          }
          const file = programFile(program, cwd, env.PATH ?? '/usr/bin:/bin');
          if (!unlimited(grants.run)) refuse(grants.run, file, program, env, loader);
          process = child.spawn(file ?? program, entries(caller.string(ap, al)), { cwd, env, stdio: modes });
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
