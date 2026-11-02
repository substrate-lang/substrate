// Web Workers in the simulated browser, each running on one of Node's threads (worker-thread.mjs). browser gives what a
// worker needs to start and to report: later, the site and answers, the program's URL, say and seen.
import { MessageChannel, Worker as NodeWorker } from 'node:worker_threads';

const thread = new URL('./worker-thread.mjs', import.meta.url);

export function makeWorker(browser) {
  const all = new Set();
  let started = 0;
  class Worker {
    constructor(url) {
      const { port1, port2 } = new MessageChannel();
      this.control = port1;
      this.onmessage = null;
      this.onerror = null;
      started++;
      browser.seen();
      this.thread = new NodeWorker(thread, {
        workerData: {
          script: String(url), control: port2, site: [...browser.site()], answers: [...browser.answers()],
          url: new URL('host/web/worker-script.mjs', browser.url()).href, seed: browser.seed + started,
        },
        transferList: [port2],
      });
      this.thread.on('message', (data) => browser.later(() => {
        if (this.onmessage) this.onmessage({ data });
      }));
      this.thread.on('error', (e) => browser.later(() => {
        if (this.onerror) this.onerror({ message: e && e.message ? e.message : String(e), preventDefault() {} });
      }));
      this.thread.on('exit', () => all.delete(this));
      port1.on('message', (m) => {
        if (m.type === 'console') browser.say(m.line);
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
    stopAll() {
      for (const w of [...all]) w.terminate();
    },
  };
}
