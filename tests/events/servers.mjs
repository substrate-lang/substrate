// Serves tests/events/files over HTTP and echoes WebSocket messages, for the event tests against the real modules.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const files = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');

const server = http.createServer((request, response) => {
  let body;
  try {
    body = fs.readFileSync(path.join(files, path.normalize(request.url)));
  } catch (e) {
    response.writeHead(404, { 'content-length': 9 });
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'content-length': body.length });
  response.end(body);
});

function frame(bytes) {
  if (bytes.length < 2) return null;
  const opcode = bytes[0] & 15;
  const masked = (bytes[1] & 128) !== 0;
  let length = bytes[1] & 127;
  let at = 2;
  if (length === 126) {
    if (bytes.length < 4) return null;
    length = bytes.readUInt16BE(2);
    at = 4;
  } else if (length === 127) {
    if (bytes.length < 10) return null;
    length = Number(bytes.readBigUInt64BE(2));
    at = 10;
  }
  const mask = masked ? bytes.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (bytes.length < at + length) return null;
  const payload = Buffer.from(bytes.subarray(at, at + length));
  if (mask) for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3];
  return { opcode, payload, size: at + length };
}

function framed(opcode, payload) {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([128 | opcode, length]) : Buffer.from([128 | opcode, 126, length >> 8, length & 255]);
  return Buffer.concat([head, payload]);
}

server.on('upgrade', (request, socket) => {
  const accept = crypto.createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let pending = Buffer.alloc(0);
  socket.on('data', (data) => {
    pending = Buffer.concat([pending, data]);
    for (let f = frame(pending); f; f = frame(pending)) {
      pending = pending.subarray(f.size);
      if (f.opcode === 8) {
        socket.end(framed(8, f.payload));
        return;
      }
      if (f.opcode === 9) socket.write(framed(10, f.payload));
      else if (f.opcode === 1 || f.opcode === 2) socket.write(framed(f.opcode, f.payload));
    }
  });
  socket.on('error', () => {});
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
