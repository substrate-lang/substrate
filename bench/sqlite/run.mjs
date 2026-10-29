// run.mjs OUT REPS: ours (OUT/ours) and native (OUT/native) on OUT/script.sql, with the database in a file and in
// memory: each test's best time of REPS runs in ms, and ours over native.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [out, reps] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const script = `${out}/script.sql`;
const file = `${out}/test.db`;

const run = (command, args) => {
  const p = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (p.status !== 0) throw new Error(`${command}: ${p.stderr}`);
  return p.stdout.trim().split('\n').map((line) => {
    const space = line.indexOf(' ');
    return { ms: Number(line.slice(0, space)), test: line.slice(space + 1) };
  });
};

const programs = {
  ours: (db) => run(process.execPath, [...process.execArgv, `${root}/host/subhost.mjs`, `-R=${out}`, `-W=${out}`,
    `${out}/ours`, script, db]),
  native: (db) => run(`${out}/native`, [script, db]),
};

const best = (who, db) => {
  let rows = null;
  for (let r = 0; r < Number(reps); r += 1) {
    for (const f of [file, `${file}-journal`]) fs.rmSync(f, { force: true });
    const got = programs[who](db);
    rows = rows === null ? got : rows.map((row, i) => ({ ...row, ms: Math.min(row.ms, got[i].ms) }));
  }
  return rows;
};

const columns = [];
for (const [where, db] of [['file', file], ['memory', ':memory:']]) {
  for (const who of ['ours', 'native']) columns.push({ where, who, rows: best(who, db) });
}
const tests = columns[0].rows.map((r) => r.test);
for (const c of columns) {
  if (c.rows.length !== tests.length || c.rows.some((r, i) => r.test !== tests[i])) {
    throw new Error(`${c.who} in ${c.where} ran other tests`);
  }
}

const width = Math.max(...tests.map((t) => t.length)) + 2;
const ratio = (ours, native) => (native >= 0.05 ? (ours / native).toFixed(2) : '-').padStart(7);
const cells = (i) => [0, 2].map((k) => {
  const [ours, native] = [columns[k].rows[i].ms, columns[k + 1].rows[i].ms];
  return `${ours.toFixed(1).padStart(9)}${native.toFixed(1).padStart(9)}${ratio(ours, native)}`;
}).join('   ');
const sum = (k) => columns[k].rows.reduce((s, r) => s + r.ms, 0);
console.log(`ms, the best of ${reps}${' '.repeat(Math.max(1, width - 11 - String(reps).length))}`
  + `${'file: ours'.padStart(13)}${'native'.padStart(9)}${'x'.padStart(7)}`
  + `${'memory: ours'.padStart(15)}${'native'.padStart(9)}${'x'.padStart(7)}`);
tests.forEach((t, i) => console.log(`${t.slice(0, width - 2).padEnd(width)}  ${cells(i)}`));
const totals = [0, 2].map((k) => `${sum(k).toFixed(1).padStart(9)}${sum(k + 1).toFixed(1).padStart(9)}`
  + `${ratio(sum(k), sum(k + 1))}`).join('   ');
console.log(`${'all'.padEnd(width)}  ${totals}`);
