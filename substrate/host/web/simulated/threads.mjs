// Web Workers for a simulated page, each one of Node's threads (worker-thread.mjs). page holds what a worker is
// started with and how it reports: later, the clock, the site and answers, the page's URL, say and seen.
import { MessageChannel, Worker as NodeWorker } from 'node:worker_threads';

const thread = new URL('./worker-thread.mjs', import.meta.url);

export function makeWorker(page) {
  const all = new Set();
  let started = 0;
  class Worker {
    constructor(url) {
      const { port1, port2 } = new MessageChannel();
      this.control = port1;
      this.onmessage = null;
      this.onerror = null;
      started++;
      page.seen();
      this.thread = new NodeWorker(thread, {
        workerData: {
          script: String(url), control: port2, now: page.clock().now(), epoch: page.clock().epoch, site: [...page.site()],
          answers: [...page.answers()], url: new URL('host/web/worker-script.mjs', page.url()).href, seed: page.seed + started,
        },
        transferList: [port2],
      });
      this.thread.on('message', (data) => page.later(() => {
        if (this.onmessage) this.onmessage({ data });
      }));
      this.thread.on('error', (e) => page.later(() => {
        if (this.onerror) this.onerror({ message: e && e.message ? e.message : String(e), preventDefault() {} });
      }));
      this.thread.on('exit', () => all.delete(this));
      port1.on('message', (m) => {
        if (m.type === 'console') page.say(m.line);
      });
      all.add(this);
    }

    postMessage(m, transfer) {
      this.thread.postMessage(m, transfer);
    }

    terminate() {
      all.delete(this);
      this.control.close();
      this.thread.terminate();
    }
  }
  return {
    Worker,
    // The workers' clocks brought to the page's time.
    tell(now) {
      for (const w of all) w.control.postMessage({ type: 'time', now });
    },
    stopAll() {
      for (const w of [...all]) w.terminate();
    },
  };
}
