// run.mjs OUT SECONDS: the server in OUT/server, Node's own http server and nginx with one worker, each loaded by wrk
// for SECONDS on 50 keep-alive connections: /hello, twelve bytes; a 16 KB page as it is, and gzipped at level 6 by
// both ours and nginx; and a 1 MB file. Node answers /hello alone.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const [out, seconds = '5'] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const www = `${out}/www`;
fs.mkdirSync(www, { recursive: true });
fs.mkdirSync(`${out}/nginx/temp`, { recursive: true });
let page = '<!doctype html>\n<title>page</title>\n';
for (let i = 0; page.length < 16384; i++) page += `<p>item ${(i * i) % 997} in group ${i % 17}</p>\n`;
fs.writeFileSync(`${www}/page.html`, page.slice(0, 16384));
fs.writeFileSync(`${www}/large.bin`, crypto.randomBytes(1048576));

const free = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const get = (port, target, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: target, headers, agent: false }, (res) => {
    res.resume();
    res.on('end', () => resolve(res));
  }).on('error', reject);
});

const ready = async (port) => {
  for (let i = 0; i < 100; i++) {
    try {
      return await get(port, '/hello');
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`nothing listens on ${port}`);
};

const servers = {};
const ours = spawn(`${root}/host/subhost.mjs`, ['-N=127.0.0.1', `-R=${www}`, `${out}/server`, www],
  { stdio: ['ignore', 'pipe', 'inherit'] });
servers.ours = { process: ours, port: Number((await new Promise((resolve) => ours.stdout.once('data', resolve)))
  .toString().match(/:(\d+)\//)[1]) };
const nodePort = await free();
servers.node = { port: nodePort, process: spawn('node', ['-e', `require('node:http').createServer((q, s) => {
  s.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  s.end('hello, world');
}).listen(${nodePort}, '127.0.0.1')`], { stdio: 'inherit' }) };
const nginxPort = await free();
const temp = `${out}/nginx/temp`;
fs.writeFileSync(`${out}/nginx/nginx.conf`, `daemon off;
worker_processes 1;
pid ${out}/nginx/nginx.pid;
error_log stderr;
events { worker_connections 1024; }
http {
  access_log off;
  client_body_temp_path ${temp}; proxy_temp_path ${temp}; fastcgi_temp_path ${temp}; uwsgi_temp_path ${temp};
  scgi_temp_path ${temp};
  types { text/html html; application/octet-stream bin; }
  sendfile on;
  keepalive_requests 10000000;
  gzip on;
  gzip_comp_level 6;
  gzip_min_length 1024;
  gzip_vary on;
  server {
    listen 127.0.0.1:${nginxPort};
    root ${www};
    location = /hello { default_type "text/plain; charset=utf-8"; return 200 "hello, world"; }
  }
}
`);
servers.nginx = { port: nginxPort,
  process: spawn('nginx', ['-p', `${out}/nginx`, '-c', `${out}/nginx/nginx.conf`, '-e', 'stderr'], { stdio: 'inherit' }) };

const ms = (s) => {
  const m = /([\d.]+)(us|ms|s)/.exec(s);
  return Number(m[1]) * { us: 0.001, ms: 1, s: 1000 }[m[2]];
};
const megabytes = (n, unit) => Number(n) * { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 }[unit];

const wrk = (port, target, headers, time) => {
  const args = ['-t2', '-c50', `-d${time}s`, '--latency', ...headers.flatMap((h) => ['-H', h]),
    `http://127.0.0.1:${port}${target}`];
  const r = spawnSync('wrk', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrk failed: ${r.stderr}`);
  const t = r.stdout;
  const transfer = /Transfer\/sec:\s+([\d.]+)(\w+)/.exec(t);
  const bad = /Non-2xx or 3xx responses: (\d+)/.exec(t);
  const errors = /Socket errors: (.*)/.exec(t);
  return {
    rate: Number(/Requests\/sec:\s+([\d.]+)/.exec(t)[1]),
    p50: ms(/ 50%\s+(\S+)/.exec(t)[1]),
    p99: ms(/ 99%\s+(\S+)/.exec(t)[1]),
    mb: megabytes(transfer[1], transfer[2]),
    problem: [bad ? `${bad[1]} not 2xx` : '', errors ? `socket errors: ${errors[1]}` : ''].filter(Boolean).join(', '),
  };
};

const cases = [
  ['hello', '/hello', [], ['ours', 'node', 'nginx']],
  ['16 KB page', '/page.html', [], ['ours', 'nginx']],
  ['16 KB page, gzip', '/page.html', ['Accept-Encoding: gzip'], ['ours', 'nginx']],
  ['1 MB file', '/large.bin', [], ['ours', 'nginx']],
];

try {
  for (const [name, s] of Object.entries(servers)) {
    await ready(s.port);
    wrk(s.port, '/hello', [], 1);
    if (name === 'node') continue;
    const zipped = await get(s.port, '/page.html', { 'accept-encoding': 'gzip' });
    if (zipped.headers['content-encoding'] !== 'gzip') throw new Error(`${name} does not gzip the page`);
  }
  const column = (v, w) => String(v).padStart(w);
  console.log(`${'case'.padEnd(18)}${'server'.padEnd(7)}${column('req/s', 10)}${column('p50 ms', 9)}${column('p99 ms', 9)}`
    + `${column('MB/s', 9)}`);
  for (const [name, target, headers, which] of cases) {
    for (const w of which) {
      const r = wrk(servers[w].port, target, headers, seconds);
      console.log(`${name.padEnd(18)}${w.padEnd(7)}${column(r.rate.toFixed(0), 10)}${column(r.p50.toFixed(2), 9)}`
        + `${column(r.p99.toFixed(2), 9)}${column(r.mb.toFixed(1), 9)}${r.problem ? `  ${r.problem}` : ''}`);
    }
  }
} finally {
  for (const s of Object.values(servers)) s.process.kill();
}
