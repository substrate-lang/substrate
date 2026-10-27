// Session tests evaluated by the compiler running in a page, against their .out files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { served, withBrowser } from './browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [site, ...names] = process.argv.slice(2);

const { server, url } = await served(site);

let failed = 0;
try {
  await withBrowser(async (open) => {
    for (const name of names) {
      const page = await open(`${url}index.html?session=${name}`);
      await page.waitFor('window.done', 60000);
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
