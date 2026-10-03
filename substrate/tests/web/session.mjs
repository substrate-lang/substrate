// Lifecycle: experimental.
//
// Tests that the compiler works when it runs inside a web page. Used by
// tests/web/run.sh.
//
//   node tests/web/session.mjs SITE NAME ...
//
// SITE is the directory of the "session" site that run.sh built. For
// each NAME, the page session.html evaluates the session test
// tests/session/NAME.sub in Chromium, and what it prints must equal
// NAME.out. tests/run.sh checks the same tests on the command line
// with `bin/sub eval`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowser } from '../../../host/web/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [site, ...names] = process.argv.slice(2);

// Serve the site. Port 0 means any free port; serve.mjs prints the
// address it chose.
const server = spawn(path.join(here, '../../../host/web/serve.mjs'), [site, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));

let failed = 0;
try {
  await withBrowser(async (open) => {
    for (const name of names) {
      const page = await open(`${url}index.html?session=${name}`);
      await page.waitFor('window.done', 60000);
      // Backtrace lines start with four spaces. They are removed because
      // their content depends on the host.
      const actual = (await page.evaluate('document.getElementById("out").textContent'))
        .split('\n').filter((l) => !l.startsWith('    ')).join('\n');
      const expected = fs.readFileSync(path.join(here, `../session/${name}.out`), 'utf8');
      if (actual === expected) {
        console.log(`ok   ${name}: ${Math.round(await page.evaluate('window.elapsed'))} ms in the page`);
      } else {
        failed++;
        console.log(`FAIL ${name}: the page's output differs\n--- the page's\n${actual}\n--- expected\n${expected}\n--- its console\n${page.log.join('\n')}`);
      }
    }
  }, { dir: site });
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
