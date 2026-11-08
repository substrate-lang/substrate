// The host module "process" (process.sub).
import child from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const launched = (file, args, program = file) => {
  const node = globalThis.process.execPath;
  return /\.m?js$/.test(file) ? { command: node, args: ['--stack-size=4000', file, ...args], argv0: node }
    : { command: file, args, argv0: program };
};

export function become(command, argv, env) {
  if (globalThis.process.platform !== 'win32') globalThis.process.execve(command, argv, env);
  const r = child.spawnSync(command, argv.slice(1), { env, stdio: 'inherit' });
  if (r.error) throw r.error;
  globalThis.process.exit(r.status !== null ? r.status : 128 + (os.constants.signals[r.signal] || 0));
}

const searchOf = (env) => env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'] ?? '/usr/bin:/bin';

const windows = globalThis.process.platform === 'win32';

const childEnv = (clear, given) => {
  const env = clear ? {} : { ...globalThis.process.env };
  for (const e of given) {
    const equals = e.indexOf('=');
    const name = equals < 0 ? e : e.slice(0, equals);
    if (windows) for (const k of Object.keys(env)) if (k.toUpperCase() === name.toUpperCase()) delete env[k];
    env[name] = equals < 0 ? '' : e.slice(equals + 1);
  }
  return env;
};

const mainOnly = (setup, call) => {
  if (setup.worker) throw new Error(`process.${call} is not available in a worker`);
};

export function processes(grants, loader, setup = {}) {
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
          const env = childEnv(clear, entries(caller.string(ep, el)));
          const file = programFile(program, cwd, searchOf(env));
          if (!unlimited(grants.run)) refuse(grants.run, file, program, env, loader);
          const l = launched(file ?? program, entries(caller.string(ap, al)));
          process = child.spawn(l.command, l.args, { cwd, env, stdio: modes });
        } catch (e) {
          caller.fail(err, e.message, errorOf(e));
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
      run(pp, pl, ap, al, dp, dl, ep, el, clear, ip, il, timeout, op, err) {
        let dir = null;
        try {
          const program = caller.string(pp, pl);
          const cwd = caller.string(dp, dl) || undefined;
          const env = childEnv(clear, entries(caller.string(ep, el)));
          const file = programFile(program, cwd, searchOf(env));
          if (!unlimited(grants.run)) refuse(grants.run, file, program, env, loader);
          dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subhost-run-'));
          const out = fs.openSync(path.join(dir, 'output'), 'w');
          let r;
          try {
            const l = launched(file ?? program, entries(caller.string(ap, al)));
            r = child.spawnSync(l.command, l.args, {
              cwd, env, input: caller.memory().slice(caller.u(ip), caller.u(ip) + il), stdio: ['pipe', out, out],
              timeout: timeout || undefined, killSignal: 'SIGKILL',
            });
          } finally {
            fs.closeSync(out);
          }
          if (r.error && r.error.code !== 'ETIMEDOUT') throw r.error;
          const p = caller.give(fs.readFileSync(path.join(dir, 'output')), caller.u(op) + 4);
          new DataView(caller.memory().buffer).setUint32(caller.u(op), p, true);
          return r.status !== null ? r.status : 128 + (os.constants.signals[r.signal] || 0);
        } catch (e) {
          caller.fail(err, e.message, errorOf(e));
          return -1;
        } finally {
          if (dir) fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      exec(pp, pl, ap, al, err) {
        try {
          mainOnly(setup, 'exec');
          const program = caller.string(pp, pl);
          const env = globalThis.process.env;
          const file = programFile(program, undefined, searchOf(env));
          if (!unlimited(grants.run)) refuse(grants.run, file, program, env, loader);
          const l = launched(file ?? program, entries(caller.string(ap, al)), program);
          become(l.command, [l.argv0, ...l.args], env);
        } catch (e) {
          caller.fail(err, e.message, errorOf(e));
        }
        return -1;
      },
      // exec_at_end keeps exec's program for subhost.mjs.
      exec_at_end(pp, pl, ap, al, err) {
        try {
          mainOnly(setup, 'exec_at_end');
          const program = caller.string(pp, pl);
          const env = { ...globalThis.process.env };
          const file = programFile(program, undefined, searchOf(env));
          if (!unlimited(grants.run)) refuse(grants.run, file, program, env, loader);
          const l = launched(file ?? program, entries(caller.string(ap, al)), program);
          setup.atEnd = { file: l.command, argv: [l.argv0, ...l.args], env };
        } catch (e) {
          caller.fail(err, e.message, errorOf(e));
          return -1;
        }
        return 0;
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
      pid: () => globalThis.process.pid,
    };
  };
}
