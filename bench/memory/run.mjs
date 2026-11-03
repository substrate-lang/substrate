// run.mjs OUT REPS: the heap's growth and resident memory of a fresh server (OUT/server) for each phase, its
// connections held open: idle, event streams plain and gzipped, WebSockets, after a 1 MB answer, and a burst of small
// requests on 50 connections. Then the compiler building itself, the best of REPS.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [out, reps = '3'] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const host = `${root}/substrate/host/subhost.mjs`;
const get = (target, more = '') => `GET ${target} HTTP/1.1\r\nhost: 127.0.0.1\r\n${more}\r\n`;
const upgrade = get('/ws', 'upgrade: websocket\r\nconnection: upgrade\r\n'
  + 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n');

const start = () => new Promise((resolve, reject) => {
  const p = spawn(host, ['--grant', 'net', '127.0.0.1', `${out}/server`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let text = '';
  p.stdout.on('data', (d) => {
    text += d;
    const m = text.match(/:(\d+)\//);
    if (m) resolve({ p, port: Number(m[1]) });
  });
  p.on('exit', (code) => reject(new Error(`the server ended with ${code}`)));
});

// open sends the request on a new connection, and gives the connection once what came back passes done.
const open = (port, request, done) => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1');
  let got = '';
  s.setEncoding('latin1');
  const heard = (d) => {
    got += d;
    if (!done(got)) return;
    s.off('data', heard);
    s.on('data', () => {});
    resolve(s);
  };
  s.on('data', heard);
  s.on('error', reject);
  s.write(request);
});

const many = async (n, make) => {
  const all = [];
  for (let i = 0; i < n; i += 200) {
    const batch = [];
    for (let k = i; k < Math.min(n, i + 200); k++) batch.push(make());
    all.push(...(await Promise.all(batch)));
  }
  return all;
};

const ask = (port, target) => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1');
  let got = '';
  s.setEncoding('latin1');
  s.on('data', (d) => { got += d; });
  s.on('end', () => resolve(got.slice(got.indexOf('\r\n\r\n') + 4)));
  s.on('error', reject);
  s.write(get(target, 'connection: close\r\n'));
});

const resident = (pid) => Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) * 1024;

const answered = (got) => got.endsWith('\r\n\r\nok');
const large = (got) => {
  const end = got.indexOf('\r\n\r\n');
  return end >= 0 && got.length >= end + 4 + 1048576;
};

const burst = async (port) => {
  const sockets = await many(50, () => open(port, get('/'), answered));
  await Promise.all(sockets.map((s) => new Promise((resolve) => {
    let left = 399;
    let got = '';
    s.removeAllListeners('data');
    s.on('data', (d) => {
      got += d;
      while (got.includes('\r\n\r\nok')) {
        got = got.slice(got.indexOf('\r\n\r\nok') + 6);
        left -= 1;
        if (left === 0) return resolve();
        s.write(get('/'));
      }
    });
    s.write(get('/'));
  })));
  return sockets;
};

const phases = [
  ['idle keep-alive', 10000, (port) => many(10000, () => open(port, get('/'), answered))],
  ['event streams', 10000, (port) => many(10000, () => open(port, get('/events'), (t) => t.includes('data: open')))],
  ['gzipped streams', 10000, (port) => many(10000, () => open(port, get('/events', 'accept-encoding: gzip\r\n'),
    (t) => t.includes('\x1f\x8b')))],
  ['websockets', 1000, (port) => many(1000, () => open(port, upgrade, (t) => t.includes('\r\n\r\n')))],
  ['after 1 MB', 20, (port) => many(20, () => open(port, get('/large'), large))],
  ['burst', 20000, burst],
];

const kb = (n) => (n / 1024).toFixed(1).padStart(12);
console.log(`${'phase'.padEnd(16)}${'count'.padStart(7)}${'heap KB'.padStart(12)}${'per one'.padStart(12)}`
  + `${'rss KB'.padStart(12)}${'per one'.padStart(12)}${'ms'.padStart(9)}`);
for (const [name, count, run] of phases) {
  const { p, port } = await start();
  const heap = Number(await ask(port, '/memory'));
  const rss = resident(p.pid);
  const t = performance.now();
  const sockets = await run(port);
  const ms = performance.now() - t;
  const grown = Number(await ask(port, '/memory')) - heap;
  const more = resident(p.pid) - rss;
  for (const s of sockets) s.destroy();
  p.removeAllListeners('exit');
  p.kill();
  await once(p, 'exit');
  console.log(`${name.padEnd(16)}${String(count).padStart(7)}${kb(grown)}${kb(grown / count)}${kb(more)}`
    + `${kb(more / count)}${ms.toFixed(0).padStart(9)}`);
}

let best = Infinity;
for (let i = 0; i < Number(reps); i++) {
  fs.rmSync(`${out}/compiler`, { recursive: true, force: true });
  const t = performance.now();
  const p = spawnSync(host, ['-A', `${root}/build/compiler`, `${root}/substrate`, 'build', 'substrate/compiler/main.sub',
    '-o', `${out}/compiler`, '-d', root], { cwd: root, encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`the compiler's build failed: ${p.stderr}`);
  best = Math.min(best, performance.now() - t);
}
console.log(`the compiler building itself: ${best.toFixed(0)} ms, the best of ${reps}`);
