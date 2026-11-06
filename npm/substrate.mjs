#!/usr/bin/env node
// The substrate command of the npm package.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major === 22 ? minor < 22 || (minor === 22 && patch < 3) : major === 24 ? minor < 15 : major < 25) {
  process.stderr.write('substrate: Node 22 (22.22.3 or newer), Node 24 (24.15 or newer) or Node 25 or newer runs substrate,'
    + ` and this is ${process.version}\n`);
  process.exit(1);
}

const home = process.env.SUBSTRATE_HOME || path.join(os.homedir(), '.substrate');
const versionOf = (dir) => {
  try {
    if (!fs.statSync(path.join(dir, 'build/sub/program')).isFile()) return null;
    return fs.readFileSync(path.join(dir, 'substrate/VERSION'), 'utf8').trim().split('.').map(Number);
  } catch {
    return null;
  }
};
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let version = versionOf(root);
const toolchains = path.join(home, 'toolchains');
for (const name of fs.existsSync(toolchains) ? fs.readdirSync(toolchains) : []) {
  const v = name.startsWith('.') ? null : versionOf(path.join(toolchains, name));
  if (v !== null && (version === null || newer(v, version))) {
    root = path.join(toolchains, name);
    version = v;
  }
}

const child = spawn(process.execPath,
  ['--stack-size=4000', path.join(root, 'substrate/host/subhost.mjs'), '-A', path.join(root, 'build/sub'), root,
    ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, SUBSTRATE_HOME: home } });
process.on('SIGINT', () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal === null) process.exit(code);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
