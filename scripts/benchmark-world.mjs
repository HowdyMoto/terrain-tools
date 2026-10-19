import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromeGPUArgs } from './chrome-gpu.mjs';
const quick = process.argv.includes('--quick');
const url =
  process.argv.find((a) => a.startsWith('--url='))?.slice(6) ??
  'http://127.0.0.1:5175';
let server, browser;
const percentile = (values, q) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? null
  );
};
const summarize = (values) => ({
  samples: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: Math.max(0, ...values),
});
try {
  if (
    !(await fetch(url)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    server = spawn(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'preview',
        '--configLoader',
        'native',
        '--host',
        '127.0.0.1',
        '--port',
        '5175',
        '--strictPort',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    for (let i = 0; i < 60; i++) {
      if (
        await fetch(url)
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.platform === 'win32'
        ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : undefined,
    args: chromeGPUArgs(),
  });
  const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(
    url +
      '/world.html' +
      (process.argv.includes('--full-detail') ? '?full-detail' : ''),
  );
  await page.waitForFunction(() => window.worldExample, { timeout: 180000 });
  await page.evaluate(() => window.worldExample.ready());
  const initial = await page.evaluate(() => ({
    adapter: window.worldExample.adapter,
    stats: window.worldExample.world.stats,
    failures: [...window.worldExample.world.streaming.errors].map(([k, e]) => [
      k,
      String(e),
    ]),
  }));
  console.log(JSON.stringify(initial));
  if (
    !/RTX 5060/.test(initial.adapter) &&
    !process.argv.includes('--allow-other-gpu')
  )
    throw new Error('Benchmark requires RTX 5060; detected ' + initial.adapter);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/world-forest.png' });
  if (initial.stats.failedTiles)
    throw new Error('World has failed tiles: ' + JSON.stringify(initial));
  await page.waitForTimeout(quick ? 1000 : 5000);
  await page.evaluate(() => window.worldExample.start());
  const laps = quick ? 1 : 3,
    seconds = quick ? 3 : 12;
  console.log('Measuring ' + laps + ' laps, ' + seconds + ' seconds per view.');
  await page.evaluate(
    ([laps, seconds]) => window.worldExample.traverse(laps, seconds),
    [laps, seconds],
  );
  await page.evaluate(() => window.worldExample.ready());
  const raw = await page.evaluate(() => window.worldExample.stop());
  // Capture outside the timing interval: screenshot readback stalls are instrumentation.
  for (const name of ['forest', 'open', 'coast']) {
    await page.evaluate(async (name) => {
      window.worldExample.view(name);
      await window.worldExample.ready();
    }, name);
    await page.waitForTimeout(750);
    await page.screenshot({ path: `test-results/world-${name}.png` });
  }
  const cleanup = await page.evaluate(async () => {
    const api = window.worldExample;
    await api.dispose();
    return {
      stats: api.world.stats,
      renderer: { ...api.renderer.info.memory },
    };
  });
  const result = {
    date: new Date().toISOString(),
    browser: browser.version(),
    configuration: {
      extentMetres: [2000, 2000],
      resolution: 128,
      tileSize: 250,
      maxResidentTiles: 12,
      laps,
      secondsPerView: seconds,
      proceduralTileSource: true,
      collision: true,
      quick,
    },
    ...raw,
    cleanup,
    summary: {
      frameMs: summarize(raw.frames),
      cpuMs: summarize(raw.cpu),
      gpuMs: summarize(raw.gpu),
      loadMs: summarize(raw.loadMilliseconds),
      longTasks: summarize(raw.longTasks),
    },
    memoryNote:
      'CPU/GPU residency counters estimate typed buffers/textures. Heap is main-thread JS only. Driver allocations, workers and host source documents are not directly measured.',
    errors,
  };
  result.meets30FPS =
    raw.frames.length > 30 &&
    result.summary.frameMs.p95 <= 33.5 &&
    !raw.stats.failedTiles &&
    !errors.length;
  await writeFile(
    'test-results/world-benchmark.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        summary: result.summary,
        meets30FPS: result.meets30FPS,
        stats: result.stats,
        errors,
      },
      null,
      2,
    ),
  );
  if (errors.length || raw.stats.failedTiles)
    throw new Error('Rendering/load errors occurred.');
  if (
    cleanup.stats.residentTiles ||
    cleanup.stats.assets.active ||
    cleanup.stats.assets.pending ||
    cleanup.stats.assets.cpuBytes ||
    cleanup.stats.assets.gpuBytes
  )
    throw new Error('World resources remain after teardown.');
} finally {
  await browser?.close();
  server?.kill();
}
