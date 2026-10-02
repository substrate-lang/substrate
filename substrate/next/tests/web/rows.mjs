// Lifecycle: experimental. What the views of next/web/examples/rows.sub
// cost in a browser: its site, which next/web/site.sh made, in Chromium,
// each of its operations timed in the page, from the click to the page
// laid out again, the fastest of a few runs. It checks nothing but that
// the rows are there: it is a measure, not a test.
//
//   next/web/site.sh next/web/examples/rows.sub build/next/web/rows
//   node next/tests/web/rows.mjs build/next/web
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowser } from '../../../host/web/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [sites] = process.argv.slice(2);
const server = spawn(path.join(here, '../../../host/web/serve.mjs'), [sites, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));

try {
  await withBrowser(async (open) => {
    const page = await open(`${url}rows/index.html`);
    await page.waitFor('window.ready', 60000);
    // A click on the element, timed in the page until its layout is done.
    const click = (selector) => page.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      const t = performance.now();
      e.click();
      document.body.offsetHeight;
      return performance.now() - t;
    })()`);
    const count = () => page.evaluate('document.querySelectorAll("tbody tr").length');
    // The fastest of n runs of an operation, each after setup.
    const measure = async (what, setup, selector, n = 5) => {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        for (const s of setup) await click(s);
        best = Math.min(best, await click(selector));
      }
      console.log(`${what.padEnd(34)} ${best.toFixed(1).padStart(7)} ms   (${await count()} rows after)`);
    };
    await measure('create 1,000 rows', ['#clear'], '#create');
    await measure('replace 1,000 rows', ['#create'], '#create');
    await measure('update every 10th of 1,000', ['#create'], '#update');
    await measure('select a row', ['#create'], 'tbody tr:nth-child(500) td:nth-child(2) a');
    await measure('swap two rows', ['#create'], '#swap');
    await measure('remove a row', ['#create'], 'tbody tr:nth-child(500) a.remove');
    await measure('append 1,000 to 1,000', ['#create'], '#append');
    await measure('clear 1,000 rows', ['#create'], '#clear');
    await measure('create 10,000 rows', ['#clear'], '#create-many', 3);
    await measure('update every 10th of 10,000', ['#create-many'], '#update', 3);
    await measure('select a row of 10,000', ['#create-many'], 'tbody tr:nth-child(5000) td:nth-child(2) a', 3);
    if (page.log.length) console.log(`--- the page's console\n${page.log.join('\n')}`);
  }, { dir: sites });
} finally {
  server.kill();
}
