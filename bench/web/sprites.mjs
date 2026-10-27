// node sprites.mjs SITES [hardware] times the many-sprites game drawn with the 2D context and with WebGPU.
import { served, withBrowser, webgpuFlags, hardwareGpuFlags } from '../../tests/web/browser.mjs';

const [sites, hardware] = process.argv.slice(2);
const counts = [1000, 5000, 20000];
const bigCounts = [100000, 200000];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const column = (text, width) => String(text).padStart(width);

const { server, url } = await served(sites);
try {
  console.log('renderer                     sprites   frame ms   drawing ms   gpu ms   frames a second');
  const runs = [
    ['sprites-canvas', '', 'canvas', {}, counts],
    ['sprites', '', 'gpu (SwiftShader)', { gpu: true, flags: webgpuFlags }, counts],
  ];
  if (hardware === 'hardware') {
    runs.push(['sprites', '&offscreen=1', 'gpu (hardware, off screen)', { gpu: true, flags: hardwareGpuFlags }, [...counts, ...bigCounts]]);
  }
  for (const [site, extra, label, options, numbers] of runs) {
    await withBrowser(async (open) => {
      for (const n of numbers) {
        const page = await open(`${url}${site}/index.html?n=${n}${extra}`);
        await page.waitFor('window.ready', 60000);
        const adapter = await page.evaluate('window.adapter');
        await page.evaluate('window.gpuModule.timing.measure = true');
        await wait(2000);
        await page.evaluate('window.reset()');
        await wait(4000);
        const s = JSON.parse(await page.evaluate('window.stats()'));
        const mean = s.intervals.reduce((a, b) => a + b, 0) / Math.max(1, s.intervals.length);
        const gpuMs = s.gpu.frames > 0 ? (s.gpu.ms / s.gpu.frames).toFixed(2) : '-';
        console.log(`${label.padEnd(28)} ${column(n, 7)} ` +
          `${column((s.program / s.frames).toFixed(2), 10)} ${column((s.host / s.frames).toFixed(2), 12)} ${column(gpuMs, 8)} ${column((1000 / mean).toFixed(1), 17)}` +
          (n === counts[0] && site === 'sprites' ? `   [${adapter}]` : ''));
        if (page.log.length) console.log('  ' + page.log.join('\n  '));
        await page.close();
      }
    }, { dir: sites, ...options });
  }
} finally {
  server.kill();
}
