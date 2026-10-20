import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromeGPUArgs } from './chrome-gpu.mjs';
import { benchmarkPower } from './benchmark-power.mjs';
const quick = process.argv.includes('--quick');
const steady = process.argv.includes('--steady');
const nearClusters = process.argv.includes('--near-clusters');
const captures = !process.argv.includes('--no-captures');
const output =
  process.argv.find((a) => a.startsWith('--output='))?.slice(9) ??
  'test-results/world-benchmark.json';
const url =
  process.argv.find((a) => a.startsWith('--url='))?.slice(6) ??
  'http://127.0.0.1:5175';
let server, browser, powerSession;
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
  powerSession = await benchmarkPower();
  console.log('Power state: ' + JSON.stringify(powerSession.power));
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
    // Expose the native adapter description in this temporary benchmark profile.
    args: [...chromeGPUArgs(), '--enable-webgpu-developer-features'],
  });
  const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  let profileSession;
  if (process.argv.includes('--profile')) {
    profileSession = await page.context().newCDPSession(page);
    await profileSession.send('Profiler.enable');
    await profileSession.send('Profiler.setSamplingInterval', {
      interval: 1000,
    });
    await profileSession.send('Profiler.start');
  }
  const loadStarted = performance.now();
  console.log('Loading the production world.');
  const parameters = new URLSearchParams();
  if (process.argv.includes('--full-detail')) parameters.set('full-detail', '');
  if (nearClusters) parameters.set('near-clusters', '');
  if (process.argv.includes('--impostors')) parameters.set('impostors', '');
  if (process.argv.includes('--eager-instances'))
    parameters.set('eager-instances', '');
  await page.goto(
    url + '/world.html' + (parameters.size ? '?' + parameters : ''),
  );
  await page.waitForFunction(() => window.worldExample, undefined, {
    timeout: 180000,
  });
  await page.evaluate(() => window.worldExample.ready());
  const initialReadyMs = performance.now() - loadStarted;
  const initial = await page.evaluate(() => ({
    adapter: window.worldExample.adapter,
    entryScripts: [...document.scripts]
      .map((script) => script.src)
      .filter(Boolean),
    prewarm: !!window.worldExample.world.options.prepareGPU,
    nearClusters: !!window.worldExample.world.options.foliageClusters?.nearby,
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
  if (captures)
    await page.screenshot({
      path: 'test-results/world-forest.png',
      timeout: 180000,
    });
  if (initial.stats.failedTiles)
    throw new Error('World has failed tiles: ' + JSON.stringify(initial));
  await page.waitForTimeout(quick ? 1000 : 5000);
  const laps = quick ? 1 : 3,
    seconds = quick ? 3 : 12;
  let raw, measurementWallMs;
  if (steady) {
    const views = [],
      samples = [];
    for (const name of ['forest', 'open', 'coast']) {
      await page.evaluate(async (name) => {
        window.worldExample.view(name);
        await window.worldExample.ready();
      }, name);
      await page.waitForTimeout(quick ? 1000 : 5000);
      const started = await page.evaluate(() => {
        window.worldExample.start();
        return performance.now();
      });
      await page.waitForTimeout(seconds * 1000);
      const sample = await page.evaluate(() => ({
        ...window.worldExample.stop(),
        measurementEnded: performance.now(),
      }));
      const duration = sample.measurementEnded - started;
      views.push({
        name,
        measurementWallMs: duration,
        averageFPS: sample.cpu.length / (duration / 1000),
        frameMs: summarize(sample.frames.slice(1)),
        cpuMs: summarize(sample.cpu),
        gpuMs: summarize(sample.gpu),
        stats: sample.stats,
        residentTiles: sample.snapshots.map((s) => s.stats.residentTiles),
      });
      samples.push(sample);
      console.log('Steady ' + JSON.stringify(views.at(-1)));
    }
    raw = { ...samples.at(-1), steadyViews: views };
    for (const key of ['cpu', 'gpu', 'longTasks', 'snapshots'])
      raw[key] = samples.flatMap((sample) => sample[key]);
    raw.frames = samples.flatMap((sample) => sample.frames.slice(1));
    measurementWallMs = views.reduce(
      (sum, view) => sum + view.measurementWallMs,
      0,
    );
  } else {
    const measurementStarted = await page.evaluate(() => {
      window.worldExample.start();
      return performance.now();
    });
    console.log(
      'Measuring ' + laps + ' laps, ' + seconds + ' seconds per view.',
    );
    await page.evaluate(
      ([laps, seconds]) => window.worldExample.traverse(laps, seconds),
      [laps, seconds],
    );
    console.log('Traversal complete; waiting for final tile loads.');
    await page.evaluate(() => window.worldExample.ready());
    raw = await page.evaluate(() => ({
      ...window.worldExample.stop(),
      measurementEnded: performance.now(),
    }));
    measurementWallMs = raw.measurementEnded - measurementStarted;
  }
  if (profileSession) {
    const { profile } = await profileSession.send('Profiler.stop');
    await writeFile(
      output.replace(/\.json$/, '') + '-profile.json',
      JSON.stringify(profile),
    );
    await profileSession.detach();
  }
  console.log(`Recorded ${raw.frames.length} frames; releasing resources.`);
  // Capture outside the timing interval: screenshot readback stalls are instrumentation.
  for (const name of captures ? ['forest', 'open', 'coast'] : []) {
    await page.evaluate(async (name) => {
      window.worldExample.view(name);
      await window.worldExample.ready();
    }, name);
    await page.waitForTimeout(750);
    await page.screenshot({
      path: `test-results/world-${name}.png`,
      timeout: 180000,
    });
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
    power: powerSession.power,
    date: new Date().toISOString(),
    browser: browser.version(),
    configuration: {
      extentMetres: [2000, 2000],
      resolution: 128,
      tileSize: 250,
      maxResidentTiles: 12,
      mode: steady ? 'resident-views' : 'streaming-traversal',
      nearClusters: initial.nearClusters,
      laps,
      secondsPerView: seconds,
      proceduralTileSource: true,
      collision: true,
      quick,
      captures,
    },
    initialReadyMs,
    initialBuild: {
      entryScripts: initial.entryScripts,
      prewarm: initial.prewarm,
    },
    measurementWallMs,
    averageFPS: raw.cpu.length / (measurementWallMs / 1000),
    frameTimeNote: steady
      ? 'Three fixed camera views, each fully loaded and warmed before recording. Timed windows exclude transitions/loading and exclude each first frame sample. FPS counts submissions, not display scanout or GPU completion.'
      : 'Frame interval percentiles exclude the first sample, which begins before recording. Average FPS counts submitted frames over the browser-clock recording window, including final tile loading. This is not display scanout or GPU completion rate.',
    ...raw,
    cleanup,
    summary: {
      frameMs: summarize(steady ? raw.frames : raw.frames.slice(1)),
      cpuMs: summarize(raw.cpu),
      gpuMs: summarize(raw.gpu),
      loadMs: summarize(raw.loadMilliseconds),
      longTasks: summarize(raw.longTasks),
    },
    memoryNote:
      'CPU/GPU residency counters estimate typed buffers/textures. Heap is main-thread JS only. Driver allocations, workers and host source documents are not directly measured.',
    errors,
  };
  result.meetsStreamingResponsiveness =
    result.summary.frameMs.max < 250 &&
    result.summary.frameMs.p95 <= 33.5 &&
    !errors.length &&
    !raw.stats.failedTiles;
  result.meets30FPS =
    raw.frames.length > 30 &&
    result.summary.frameMs.p95 <= 33.5 &&
    (!steady || raw.steadyViews.every((view) => view.frameMs.p95 <= 33.5)) &&
    !raw.stats.failedTiles &&
    !errors.length;
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        averageFPS: result.averageFPS,
        measurementWallMs,
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
  await powerSession?.close();
}
