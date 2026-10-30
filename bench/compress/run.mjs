// run.mjs OUT REPS FILE...: ours (OUT/ours), zlib as wasm (OUT/zlib.wasm, run here) and native (OUT/zlib.native) on
// each file: deflate at levels 1, 6 and 9 and inflate of level 6 in MB/s, the sizes, and the round trips both ways.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WASI } from 'node:wasi';

const [out, reps, ...given] = process.argv.slice(2);
const files = given.map((f) => fs.realpathSync(f));
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const phases = ['d1', 'd6', 'd9', 'i6'];

const parse = (text) => Object.fromEntries(text.trim().split('\n').map((line) => {
  const w = line.split(' ');
  const r = { size: Number(w[1]) };
  for (let i = 2; i < w.length; i += 1) {
    if (/^d\d$/.test(w[i])) r[w[i]] = { ms: Number(w[i + 1]), bytes: Number(w[i + 2]) }, i += 2;
    else if (w[i] === 'i6') r.i6 = { ms: Number(w[i + 1]), same: w[i + 2] === 'same' }, i += 2;
    else if (/^x\d$/.test(w[i])) r[w[i]] = w[i + 1] === 'ok', i += 1;
  }
  return [w[0], r];
}));

const run = (command, args) => {
  const p = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (p.status !== 0) throw new Error(`${command}: ${p.stderr}`);
  return p.stdout;
};

for (const f of fs.readdirSync(out)) if (f.endsWith('.deflate')) fs.rmSync(path.join(out, f));
const dirs = [...new Set(files.map((f) => path.dirname(f)))];
const native = parse(run(`${out}/zlib.native`, [reps, out, ...files]));
const grants = [...dirs.map((d) => `-R=${d}`), `-R=${out}`, `-W=${out}`];
const ours = parse(run(process.execPath, [...process.execArgv, `${root}/substrate/host/subhost.mjs`, ...grants, `${out}/ours`, reps,
  out, ...files]));
const checked = parse(run(`${out}/zlib.native`, ['0', out, ...files]));
const wasi = new WASI({
  version: 'preview1',
  args: ['zlib', reps, '-', ...files.map((f) => `/d${dirs.indexOf(path.dirname(f))}/${path.basename(f)}`)],
  preopens: Object.fromEntries(dirs.map((d, i) => [`/d${i}`, d])),
  stdout: fs.openSync(`${out}/zlib-wasm.txt`, 'w'),
});
const { instance } = await WebAssembly.instantiate(fs.readFileSync(`${out}/zlib.wasm`), wasi.getImportObject());
wasi.start(instance);
const wasm = parse(fs.readFileSync(`${out}/zlib-wasm.txt`, 'utf8'));

const names = Object.keys(native);
const total = (set, phase, key) => names.reduce((s, n) => s + set[n][phase][key], 0);
const bytes = names.reduce((s, n) => s + native[n].size, 0);
const mbs = (size, ms) => (size / ms / 1000).toFixed(1);
console.log(`${names.length} files, ${(bytes / 1e6).toFixed(1)} MB; MB/s, and size as % of the input`);
console.log(`${'phase'.padEnd(7)}${'ours'.padStart(8)}${'zlib wasm'.padStart(11)}${'zlib'.padStart(8)}`
  + `${'ours/zlib wasm'.padStart(16)}${'ours %'.padStart(9)}${'zlib %'.padStart(9)}`);
for (const phase of phases) {
  const row = [ours, wasm, native].map((set) => total(set, phase, 'ms'));
  const sizes = phase === 'i6' ? '' : [ours, native].map((set) => (100 * total(set, phase, 'bytes') / bytes).toFixed(2)
    .padStart(9)).join('');
  console.log(`${phase.padEnd(7)}${row.map((ms, i) => mbs(bytes, ms).padStart(i === 1 ? 11 : 8)).join('')}`
    + `${(row[1] / row[0]).toFixed(2).padStart(16)}${sizes}`);
}
console.log('\nper file: deflate 6 MB/s ours, zlib wasm, zlib; size ours, zlib');
for (const n of names) {
  const speeds = [ours, wasm, native].map((s) => mbs(s[n].size, s[n].d6.ms).padStart(8)).join('');
  console.log(`${n.replace(/^[0-9a-z]{32}-/, '').padEnd(18)}${speeds}`
    + `${String(ours[n].d6.bytes).padStart(11)}${String(native[n].d6.bytes).padStart(11)}`);
}
const fails = [];
for (const n of names) {
  if (!ours[n].i6.same) fails.push(`${n}: ours does not inflate its own level 6`);
  for (const x of ['x1', 'x6', 'x9']) {
    if (ours[n][x] !== true) fails.push(`${n}: ours does not inflate zlib's ${x}`);
    if (checked[n][x] !== true) fails.push(`${n}: zlib does not inflate ours ${x}`);
  }
}
console.log(fails.length === 0 ? '\nround trips: every level of every file, both ways' : `\n${fails.join('\n')}`);
