// Lifecycle: experimental.
//
// Measures the two renderers of the game library: the canvas's 2D
// context, and WebGPU (lib/web/scene/sprites.sub on host/web/gpu.mjs).
// It opens the many-sprites game (tests/web/sprites-world.sub) with
// each, for several numbers of sprites, and prints how long a frame
// takes. Build the sites first, as tests/web/run.sh does, then:
//
//   node tests/web/sprites.mjs build/web
//
// With a third argument, "hardware", WebGPU is also measured on the
// machine's own GPU, drawing off screen: a headless browser cannot
// present a WebGPU canvas on it (host/web/browser.mjs, hardwareGpuFlags).
//
// The browser is headless Chromium with no GPU, so both renderers draw
// in software here: the 2D context with Skia, WebGPU with SwiftShader,
// which is slow. The numbers that carry over to a real browser are what
// the two paths cost on the processor: "frame ms" is the program's time
// for a frame, which includes "drawing ms", the host's part of it. "gpu
// ms" is how long the GPU (SwiftShader, or the hardware) took to finish
// a frame after it was handed over, and "frames a second" follows from
// it here. For numbers from a real browser, open the page:
//
//   host/web/serve.mjs build/web/sprites
//   http://127.0.0.1:8000/?n=20000
//
// It shows its own numbers at the top.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowser, webgpuFlags, hardwareGpuFlags } from '../../../host/web/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [sites, hardware] = process.argv.slice(2);
const counts = [1000, 5000, 20000];
// The hardware is also given these; software drawing would take seconds
// a frame.
const bigCounts = [100000, 200000];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const column = (text, width) => String(text).padStart(width);

const server = spawn(path.join(here, '../../../host/web/serve.mjs'), [sites, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));
// The 2D context is measured in the browser as the tests run it, with no
// GPU process; WebGPU needs the GPU process and its flags, which also
// change how the 2D context draws, so each renderer gets a browser of
// its own.
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
