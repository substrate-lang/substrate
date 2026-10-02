#!/usr/bin/env node
// Lifecycle: experimental.
//
// A minimal static file server, for trying a site on this machine. A site
// built by next/web/site.sh is only static files, so any other web server
// works just as well.
//
//   host/web/serve.mjs DIR [PORT]
//
// Serves the files in DIR on 127.0.0.1, on PORT (default 8000). If PORT
// is 0, a free port is chosen. Prints the address on standard output, as
// "http://127.0.0.1:PORT/".
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
  '.svg': 'image/svg+xml',
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
  // Only serve files inside the directory: reject any path that resolves
  // to somewhere outside it (for example with "..").
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
