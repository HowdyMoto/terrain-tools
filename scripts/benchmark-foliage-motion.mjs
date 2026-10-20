import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromeGPUArgs } from './chrome-gpu.mjs';
import { foliageMotionScene } from './foliage-motion-scene.mjs';
import { runtimePackagePage } from '../tests/browser/runtime-package-page.mjs';

// Run after building, separately from other benchmarks, tests and encoders.
const value = (name) =>
  process.argv
    .find((a) => a.startsWith('--' + name + '='))
    ?.split('=')
    .slice(1)
    .join('=');
const output = resolve(value('output') ?? '.qa/foliage-motion-benchmark.json');
const baseline = value('baseline-lib') ? resolve(value('baseline-lib')) : null;
const capture = process.argv.includes('--capture');
const port = Number(value('port') ?? 5197);
const lodDensity = Number(value('density') ?? 1);
if (!Number.isFinite(lodDensity) || lodDensity < 0 || lodDensity > 1)
  throw new Error('Density must be from 0 to 1.');
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid preview port.');
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--configLoader',
    'native',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { stdio: 'ignore', windowsHide: true },
);
const url = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath:
    process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : undefined,
  args: chromeGPUArgs(),
});
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
  };
};
const gpuStatus = () => {
  try {
    return execFileSync(
      'nvidia-smi',
      [
        '--query-gpu=name,driver_version,utilization.gpu,memory.used',
        '--format=csv',
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
  } catch {
    return 'unavailable';
  }
};
const results = [];
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null)
      throw new Error(
        `Owned preview exited; port ${port} may already be in use.`,
      );
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* Starting the owned preview. */
    }
    if (attempt === 99) throw new Error('Preview server did not become ready.');
    await new Promise((r) => setTimeout(r, 200));
  }
  const beforeGPU = gpuStatus();
  await mkdir(resolve(output, '..'), { recursive: true });
  const modes = baseline
    ? ['baseline', 'current', 'current', 'baseline']
    : ['current', 'current'];
  for (const [trial, mode] of (capture
    ? [...new Set(modes)]
    : modes
  ).entries()) {
    if (server.exitCode !== null)
      throw new Error('Owned preview is no longer running.');
    console.log(
      `${capture ? 'Capturing' : 'Measuring'} ${mode}, trial ${trial + 1}`,
    );
    const context = await browser.newContext({
      baseURL: url,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      ...(capture
        ? {
            recordVideo: {
              dir: resolve('.qa/foliage-motion-video'),
              size: { width: 1280, height: 720 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await runtimePackagePage(page);
    if (baseline)
      await page.route('**/__motion_baseline/**', async (route) => {
        const relative = new URL(route.request().url()).pathname.slice(
          '/__motion_baseline/'.length,
        );
        const path = resolve(baseline, relative);
        if (!path.startsWith(baseline + sep)) return route.abort();
        await route.fulfill({
          contentType: 'text/javascript',
          body: await readFile(path),
        });
      });
    // runtimePackagePage uses relative requests; return to this owned preview.
    await page.goto(url + '/__runtime_test/index.html');
    const fixture = await page.evaluate(foliageMotionScene, {
      runtimeURL:
        mode === 'baseline' ? '/__motion_baseline/' : '/__runtime_test/lib/',
      lodDensity,
    });
    if (
      !/nvidia.*blackwell|RTX 5060/i.test(fixture.adapter) &&
      !process.argv.includes('--allow-other-gpu')
    )
      throw new Error(
        'Expected the RTX 5060 native adapter: ' + fixture.adapter,
      );
    const result = await page.evaluate(async (capture) => {
      const s = window.foliageMotionScene;
      const cpu = [],
        gpu = [],
        intervals = [];
      let last = 0;
      const frames = capture ? 180 : 150;
      for (let i = 0; i < frames; i++) {
        const now = await new Promise(requestAnimationFrame);
        const started = performance.now();
        s.step();
        const submitted = performance.now() - started;
        if (i >= 30 && !capture) {
          cpu.push(submitted);
          intervals.push(now - last);
          if (s.renderer.hasFeature('timestamp-query')) {
            await s.renderer.resolveTimestampsAsync('render');
            gpu.push(s.renderer.info.render.timestamp);
          }
        }
        last = now;
      }
      const temporal = await s.pixels();
      // The baseline's TRAA mutates Camera.aspect; the reference must still use
      // the intended viewport projection, not a different camera composition.
      s.camera.aspect = innerWidth / innerHeight;
      s.camera.updateProjectionMatrix();
      s.environment.set(
        { ...s.project.environment, temporalAA: false },
        s.project,
      );
      for (let i = 0; i < 4; i++) {
        await new Promise(requestAnimationFrame);
        s.step(0, false);
        await s.renderer.backend.device.queue.onSubmittedWorkDone();
      }
      const reference = await s.pixels();
      let error = 0,
        edgeError = 0,
        edgeSamples = 0;
      for (let i = 0; i < reference.length; i += 4) {
        let local = 0;
        for (let c = 0; c < 3; c++)
          local += Math.abs(temporal[i + c] - reference[i + c]);
        error += local / 3;
        if (
          i + 4 < reference.length &&
          Math.abs(reference[i + 1] - reference[i + 5]) > 20
        ) {
          edgeError += local / 3;
          edgeSamples++;
        }
      }
      const memoryBytes = s.renderer.info.memory.total;
      s.environment.set(s.project.environment, s.project);
      for (let i = 0; i < 4; i++) {
        await new Promise(requestAnimationFrame);
        s.step(0, false);
        await s.renderer.backend.device.queue.onSubmittedWorkDone();
      }
      return {
        cpu,
        gpu,
        intervals,
        memoryBytes,
        temporalReference: {
          meanRGBError: error / (reference.length / 4),
          meanEdgeRGBError: edgeError / edgeSamples,
          edgeSamples,
        },
        stats: s.terrain.foliage.viewStats,
        errors: s.errors,
      };
    }, capture);
    if (result.errors.length || errors.length)
      throw new Error(JSON.stringify({ errors, gpu: result.errors }));
    await page.screenshot({
      path: output.replace(/\.json$/i, `-${mode}-${trial + 1}.png`),
    });
    const cleanupBytes = await page.evaluate(() =>
      window.foliageMotionScene.dispose(),
    );
    if (cleanupBytes !== 0)
      throw new Error('Tracked GPU resources retained: ' + cleanupBytes);
    const video = capture ? page.video() : null;
    await context.close();
    let videoPath;
    if (video) {
      videoPath = output.replace(/\.json$/i, `-${mode}.webm`);
      await video.saveAs(videoPath);
    }
    results.push({
      mode,
      trial,
      ...fixture,
      ...result,
      cleanupBytes,
      videoPath,
      summary: {
        cpuMs: summarize(result.cpu),
        gpuMs: summarize(result.gpu),
        frameMs: summarize(result.intervals),
      },
    });
  }
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    node: process.version,
    baselineLibrary: baseline,
    currentBaseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
    }).trim(),
    buildSHA256: {
      current: createHash('sha256')
        .update(await readFile('lib/runtime.js'))
        .digest('hex'),
      baseline: baseline
        ? createHash('sha256')
            .update(await readFile(resolve(baseline, 'runtime.js')))
            .digest('hex')
        : null,
    },
    capture,
    beforeGPU,
    afterGPU: gpuStatus(),
    note: `400 CC0 fern instances with LOD density ${lodDensity}, transitions, terrain, shadows, Standard ocean capture, GTAO and TRAA at 1080p. CPU times end at submission; GPU timestamps include composed render passes. RAF intervals include timestamp resolution overhead. Screenshots and reference readbacks occur outside timing. RGB error is versus a paused non-temporal MSAA reference, not ground truth. Capture mode is excluded from performance evidence.`,
    results,
  };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      results.map((r) => ({
        mode: r.mode,
        summary: r.summary,
        temporalReference: r.temporalReference,
      })),
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.kill();
}
