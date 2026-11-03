// run.mjs OUT REPS FILE...: ours (OUT/ours), cJSON as wasm (OUT/cjson.wasm, run here) and native (OUT/cjson.native),
// and V8's JSON, on each file; each phase's best time in ms, and each program's sum, which must agree.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WASI } from 'node:wasi';

const [out, reps, ...files] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const flags = process.execArgv;

const lines = (text) =>
  Object.fromEntries(text.trim().split('\n').map((line) => {
    const w = line.split(' ');
    const r = {};
    let key = '';
    for (const x of w.slice(1)) {
      if (Number.isNaN(Number(x))) r[(key = x)] = [];
      else r[key].push(Number(x));
    }
    r.sum = r.sum[0];
    return [w[0], r];
  }));

const run = (command, args) => {
  const p = spawnSync(command, args, { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`${command}: ${p.stderr}`);
  return p.stdout;
};

const dir = path.dirname(files[0]);
const ours = lines(run(process.execPath, [...flags, `${root}/substrate/host/subhost.mjs`, '--grant', 'read', dir,
  `${out}/ours`, reps, ...files]));
const native = lines(run(`${out}/cjson.native`, [reps, ...files]));

let printed = '';
const wasi = new WASI({
  version: 'preview1', args: ['cjson', reps, ...files.map((f) => `/data/${path.basename(f)}`)], preopens: { '/data': dir },
  stdout: fs.openSync(`${out}/cjson-wasm.txt`, 'w'),
});
const { instance } = await WebAssembly.instantiate(fs.readFileSync(`${out}/cjson.wasm`), wasi.getImportObject());
wasi.start(instance);
printed = fs.readFileSync(`${out}/cjson-wasm.txt`, 'utf8');
const wasm = lines(printed);

const sum = (v) => {
  let s = 1;
  if (typeof v === 'number') s += v;
  else if (typeof v === 'string') s += Buffer.byteLength(v);
  else if (v && typeof v === 'object') for (const c of Object.values(v)) s += sum(c);
  return s;
};
const best = (f) => {
  let b = Infinity;
  for (let i = 0; i < Number(reps); i++) {
    const t = performance.now();
    f();
    b = Math.min(b, performance.now() - t);
  }
  return b;
};
const v8 = {};
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const v = JSON.parse(text);
  v8[path.basename(f)] = {
    sum: sum(v), parse: [best(() => JSON.parse(text))], write: [best(() => JSON.stringify(v)), Buffer.byteLength(JSON.stringify(v))],
    indented: [best(() => JSON.stringify(v, null, 2)), Buffer.byteLength(JSON.stringify(v, null, 2))],
  };
}

const ms = (x) => (x === undefined ? '-' : x.toFixed(2));
console.log(`${'file'.padEnd(18)}${'phase'.padEnd(10)}${'ours'.padStart(8)}${'cJSON wasm'.padStart(12)}${'cJSON'.padStart(8)}`
  + `${'V8'.padStart(8)}${'ours/cJSON wasm'.padStart(17)}`);
for (const f of files.map((f) => path.basename(f))) {
  const o = ours[f], w = wasm[f], c = native[f], j = v8[f];
  const sums = [o.sum, w.sum, c.sum, j.sum];
  for (const [phase, mine, theirs] of [['parse', 'parse', 'parse'], ['write', 'write', 'write'], ['numbers', 'numbers', 'write'],
    ['indented', 'indented', 'indented']]) {
    const row = [o[mine][0], w[theirs][0], c[theirs][0], j[theirs][0]];
    console.log(`${f.padEnd(18)}${phase.padEnd(10)}${row.map((x, i) => ms(x).padStart(i === 1 ? 12 : 8)).join('')}`
      + `${(row[0] / row[1]).toFixed(2).padStart(17)}`);
  }
  if (!sums.every((s) => s === sums[0])) console.log(`${f}: the sums differ: ${sums.join(' ')}`);
}
