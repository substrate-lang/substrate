#!/usr/bin/env node
// A minimal static file server on 127.0.0.1, for trying a site locally.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [dir, port = '8000'] = process.argv.slice(2);
if (!dir) {
  process.stderr.write('usage: host/web/serve.mjs DIR [PORT]\n');
  process.exit(64);
}
const root = path.resolve(dir);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

const server = http.createServer((request, response) => {
  let name;
  try {
    name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch (e) {
    response.writeHead(400).end();
    return;
  }
  let file = path.join(root, name);
  if (file !== root && !file.startsWith(root + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (error, bytes) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    response.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(bytes);
  });
});
server.listen(Number(port), '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}/\n`);
});
