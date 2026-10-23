// The host module "process": child programs, their three pipes being streams.
// Kinds: exit 1, value the exit code, or 128 plus the signal; failed 2, value the error code.
// A spec is lines: program PATH; arg TEXT; dir PATH; env NAME=VALUE; and stdin, stdout or stderr followed by
// ignore or inherit, for a pipe the program will not read or write.
import child from 'node:child_process';
import os from 'node:os';
import { errorOf } from '../errors.mjs';
import { nodeSource } from '../streams.mjs';
import { settings } from '../settings.mjs';

const utf8 = new TextEncoder();

const SOURCE = 10;
const EXIT = 1;
const FAILED = 2;

const pipes = ['stdin', 'stdout', 'stderr'];

function parseSpec(text) {
  const spec = { program: null, args: [], dir: null, env: {}, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' };
  settings(text, 'process.spawn', (word, value) => {
    if (word === 'program') spec.program = value;
    else if (word === 'arg') spec.args.push(value);
    else if (word === 'dir') spec.dir = value;
    else if (word === 'env') {
      const equals = value.indexOf('=');
      spec.env[equals < 0 ? value : value.slice(0, equals)] = equals < 0 ? '' : value.slice(equals + 1);
    } else if (pipes.includes(word) && (value === 'ignore' || value === 'inherit')) spec[word] = value;
    else return false;
    return true;
  });
  if (spec.program === null) throw new Error('process.spawn: the spec has no "program" line');
  return spec;
}

export function processes() {
  const children = new Map();
  let next = 1;
  return (caller) => {
    return {
      source: SOURCE,
      end() {
        for (const c of children.values()) c.process.kill();
        children.clear();
      },
      spawn(ptr, len, tag) {
        let spec;
        let process;
        try {
          spec = parseSpec(caller.string(ptr, len));
          process = child.spawn(spec.program, spec.args, {
            cwd: spec.dir || undefined,
            env: { ...globalThis.process.env, ...spec.env },
            stdio: pipes.map((pipe) => spec[pipe]),
          });
        } catch (e) {
          caller.error(e.message);
          return 0;
        }
        const id = next++;
        const c = { process };
        for (const pipe of pipes) c[pipe] = spec[pipe] === 'pipe' ? caller.streams.add(tag, nodeSource(process[pipe])) : 0;
        children.set(id, c);
        process.on('error', (e) => {
          if (children.get(id) !== c) return;
          children.delete(id);
          caller.event(FAILED, id, tag, errorOf(e), utf8.encode(e.message));
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
