// run.mjs OUT REPS: ours (OUT/ours), mbedTLS as wasm (OUT/mbedtls.wasm, run here) and native (OUT/mbedtls.native);
// each phase's best time in ms, and each result's first bytes, which must agree.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WASI } from 'node:wasi';

const [out, reps] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const lines = (text) => Object.fromEntries(text.trim().split('\n').map((line) => {
  const [phase, ms, check] = line.split(' ');
  return [phase, { ms: Number(ms), check }];
}));

const run = (command, args) => {
  const p = spawnSync(command, args, { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`${command}: ${p.stderr}`);
  return p.stdout;
};

const ours = lines(run(process.execPath, [...process.execArgv, `${root}/substrate/host/subhost.mjs`, `${out}/ours`,
  reps]));
const native = lines(run(`${out}/mbedtls.native`, [reps]));
const wasi = new WASI({
  version: 'preview1', args: ['mbedtls', reps], stdout: fs.openSync(`${out}/mbedtls-wasm.txt`, 'w'),
});
const { instance } = await WebAssembly.instantiate(fs.readFileSync(`${out}/mbedtls.wasm`), wasi.getImportObject());
wasi.start(instance);
const wasm = lines(fs.readFileSync(`${out}/mbedtls-wasm.txt`, 'utf8'));

console.log(`${'phase'.padEnd(8)}${'ours'.padStart(10)}${'mbedTLS wasm'.padStart(14)}${'mbedTLS'.padStart(10)}`
  + `${'ours/mbedTLS wasm'.padStart(19)}`);
for (const phase of ['sha256', 'hmac', 'pbkdf2']) {
  const row = [ours[phase], wasm[phase], native[phase]];
  console.log(`${phase.padEnd(8)}${row.map((r, i) => r.ms.toFixed(2).padStart(i === 1 ? 14 : 10)).join('')}`
    + `${(row[0].ms / row[1].ms).toFixed(2).padStart(19)}`);
  if (!row.every((r) => r.check === row[0].check)) {
    console.log(`${phase}: the results differ: ${row.map((r) => r.check)}`);
  }
}
