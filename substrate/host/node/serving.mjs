// Runs a browser test's server on its own thread for browser.mjs. The server is a program given the site's directory.
// It prints its address on its first line, and it is stopped when its browser closes.
import { spawn } from 'node:child_process';
import { workerData } from 'node:worker_threads';

const { port, signal, command, args } = workerData;
let child = null;
let said = '';

const reply = (m) => {
  port.postMessage(m);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
};

port.on('message', (m) => {
  if (m.type === 'start') {
    let out = '';
    let answered = false;
    const answer = (r) => {
      if (answered) return;
      answered = true;
      reply(r);
    };
    child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      if (answered) return;
      out += d;
      const k = out.indexOf('\n');
      if (k >= 0) answer({ ok: true, text: out.slice(0, k).trim() });
    });
    child.stderr.on('data', (d) => {
      said = (said + d).slice(-4000);
    });
    child.on('error', (e) => answer({ ok: false, message: `the server cannot start: ${e.message}` }));
    child.on('exit', (code) => answer({ ok: false, message: `the server ended with ${code} before printing its address\n${said.trim()}` }));
  } else if (child && child.exitCode === null && child.signalCode === null) {
    child.once('exit', () => reply({ ok: true, text: '' }));
    child.kill();
  } else {
    reply({ ok: true, text: '' });
  }
});
