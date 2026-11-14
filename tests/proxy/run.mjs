// run.mjs OUT SERVER: Caddy, then nginx, over TLS with OUT/cert.pem, in front of a fresh SERVER each: the
// client's address and scheme despite its own X-Forwarded-For; events arriving apart, as they are and gzipped; a
// WebSocket kept open by pings past nginx's read timeout; and a request answered as the server shuts down.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';

const [out, server] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const cert = fs.readFileSync(`${out}/cert.pem`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;

const freePort = async () => {
  const s = net.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  s.close();
  await once(s, 'close');
  return port;
};

const startServer = () => new Promise((resolve, reject) => {
  const p = spawn(`${root}/substrate/host/subhost.mjs`, ['--grant', 'net', '127.0.0.1', server],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  let text = '';
  p.stdout.on('data', (d) => {
    text += d;
    const m = text.match(/:(\d+)\//);
    if (m) resolve({ p, port: Number(m[1]) });
  });
  p.on('error', reject);
});

const files = { CERT: `${out}/cert.pem`, KEY: `${out}/key.pem` };

const proxies = {
  caddy(port, server) {
    const home = `${out}/caddy`;
    return spawn('caddy', ['run', '--config', `${here}/Caddyfile`, '--adapter', 'caddyfile'], {
      env: { ...process.env, ...files, PROXY_PORT: port, SERVER_PORT: server, HOME: home, XDG_DATA_HOME: home,
        XDG_CONFIG_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  },
  nginx(port, server) {
    const dir = `${out}/nginx`;
    fs.mkdirSync(`${dir}/temp`, { recursive: true });
    const conf = Object.entries({ ...files, PIDFILE: `${dir}/nginx.pid`, TEMP: `${dir}/temp`, PROXY_PORT: port,
      SERVER_PORT: server }).reduce((text, [name, value]) => text.replaceAll(name, String(value)),
      fs.readFileSync(`${here}/nginx.conf`, 'utf8'));
    fs.writeFileSync(`${dir}/nginx.conf`, conf);
    return spawn('nginx', ['-p', dir, '-c', `${dir}/nginx.conf`, '-e', 'stderr'], { stdio: ['ignore', 'ignore', 'pipe'] });
  },
};

const ready = async (port) => {
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: cert }, () => {
        s.end();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (up) return;
    await pause(100);
  }
  throw new Error(`nothing listens on ${port}`);
};

const options = (port, target, headers = {}) => ({
  host: '127.0.0.1', port, path: target, servername: 'localhost', ca: cert, agent: false,
  headers: { host: `localhost:${port}`, ...headers },
});

const get = (port, target, headers) => new Promise((resolve, reject) => {
  https.request(options(port, target, headers), (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve(`${res.statusCode} ${body}`));
  }).on('error', reject).end();
});

// events gives when each event came, in ms from the request, and the stream's encoding.
const events = (port, zipped) => new Promise((resolve, reject) => {
  const start = performance.now();
  const times = {};
  const headers = zipped ? { accept: 'text/event-stream', 'accept-encoding': 'gzip' } : { accept: 'text/event-stream' };
  https.request(options(port, '/events', headers), (res) => {
    const body = zipped ? res.pipe(zlib.createGunzip()) : res;
    let text = '';
    body.setEncoding('utf8');
    body.on('data', (d) => {
      text += d;
      for (const name of ['one', 'two']) if (!(name in times) && text.includes(`data: ${name}`)) times[name] = performance.now() - start;
    });
    body.on('end', () => resolve({ ...times, encoding: res.headers['content-encoding'] ?? 'none' }));
  }).on('error', reject).end();
});

const frame = (opcode, payload) => {
  const p = Buffer.from(payload);
  const f = Buffer.alloc(6 + p.length);
  f[0] = 0x80 | opcode;
  f[1] = 0x80 | p.length;
  [1, 2, 3, 4].forEach((m, i) => { f[2 + i] = m; });
  for (let i = 0; i < p.length; i++) f[6 + i] = p[i] ^ (i % 4 + 1);
  return f;
};

// websocket answers the server's pings, sends a message after 4 s, and tells whether it came back.
const websocket = (port) => new Promise((resolve) => {
  const s = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: cert });
  let buf = Buffer.alloc(0);
  let upgraded = false;
  let result = 'closed before the echo';
  s.on('secureConnect', () => s.write(`GET /ws HTTP/1.1\r\nhost: localhost:${port}\r\norigin: https://localhost:${port}\r\n`
    + 'upgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-version: 13\r\n'
    + 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!upgraded) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const status = buf.subarray(0, end).toString().split('\r\n')[0];
      if (!status.startsWith('HTTP/1.1 101')) {
        result = `refused: ${status}`;
        s.destroy();
        return;
      }
      upgraded = true;
      buf = buf.subarray(end + 4);
      setTimeout(() => s.write(frame(1, 'hi')), 4000);
    }
    while (buf.length >= 2 && (buf[1] & 127) < 126 && buf.length >= 2 + (buf[1] & 127)) {
      const opcode = buf[0] & 15;
      const payload = buf.subarray(2, 2 + (buf[1] & 127));
      buf = buf.subarray(2 + payload.length);
      if (opcode === 9) s.write(frame(10, payload));
      else if (opcode === 1 && payload.toString() === 'hi') {
        result = 'echoed after 4 s';
        s.end();
      }
    }
  });
  s.on('error', () => {});
  s.on('close', () => resolve(result));
});

const check = (name, got, expected) => {
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`}`);
};

for (const [name, start] of Object.entries(proxies)) {
  const server = await startServer();
  const port = await freePort();
  const proxy = start(port, server.port);
  let log = '';
  proxy.stderr.on('data', (d) => { log += d; });
  try {
    await ready(port);
    check(`${name}: the client's address and scheme`, await get(port, '/address', { 'x-forwarded-for': '1.2.3.4' }),
      '200 127.0.0.1 https');
    const times = await events(port, false);
    check(`${name}: an event comes before the next is sent`, times.one < 400 && times.two >= 450, true);
    const zipped = await events(port, true);
    check(`${name}: a gzipped event comes before the next is sent`,
      `${zipped.encoding} ${zipped.one < 400 && zipped.two >= 450}`, 'gzip true');
    check(`${name}: a WebSocket kept open by pings`, await websocket(port), 'echoed after 4 s');
    const slow = get(port, '/slow');
    await pause(300);
    server.p.kill('SIGTERM');
    const answer = await slow;
    const [code] = await once(server.p, 'exit');
    check(`${name}: a request in hand as the server shuts down`, `${answer}, then exited ${code}`,
      '200 slow, then exited 0');
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}\n${log}`);
    server.p.kill();
  }
  proxy.kill();
  await once(proxy, 'exit');
}
process.exit(failed > 0 ? 1 : 0);
