#!/usr/bin/env node
// The substrate command of the npm package.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 24) {
  process.stderr.write(`substrate: Node 24 or newer runs substrate, and this is ${process.version}\n`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath,
  ['--stack-size=4000', path.join(root, 'substrate/host/subhost.mjs'), '-A', path.join(root, 'build/sub'), root,
    ...process.argv.slice(2)],
  { stdio: 'inherit' });
process.on('SIGINT', () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal === null) process.exit(code);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
