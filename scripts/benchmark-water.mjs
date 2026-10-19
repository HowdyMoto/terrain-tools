import { chromium, expect as baseExpect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { chromeGPUArgs } from './chrome-gpu.mjs';
// Instrument a development page only. The input content project is never modified.
const projectPath = process.argv[2];
if (!projectPath)
  throw new Error(
    'Usage: node scripts/benchmark-water.mjs <project.terrain> [report.json] [dev URL] [coast|canopy]',
  );
const output = process.argv[3] ?? '.qa/water-performance.json';
const url = process.argv[4] ?? 'http://127.0.0.1:5190';
const view = process.argv[5] ?? 'coast';
if (!['coast', 'canopy'].includes(view))
  throw new Error('Expected coast or canopy view.');
const expect = baseExpect.configure({ timeout: 120000 });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: chromeGPUArgs(),
});
const results = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('PAGE ERROR', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && /THREE|Shader|WebGL/i.test(m.text()))
      errors.push(m.text());
  });
  await page.route('**/src/main.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()) + '\nwindow.__waterViewport=viewport;',
    });
  });
  await page.goto(url);
  console.log('Editor opened');
  await expect(page.locator('#app')).not.toHaveAttribute('inert');
  const adapter = await page.evaluate(() => window.__waterViewport.gpuRenderer);
  if (!/RTX 5060/i.test(adapter))
    throw new Error('Expected RTX 5060; actual adapter: ' + adapter);
  await page.locator('#file-open').setInputFiles(projectPath);
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  console.log('Content project loaded');
  await page.locator('#frame').click();
  await page.locator('#fullscreen').click();
  await page.keyboard.press('v');
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await expect(page.locator('#walk-hint')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await expect
    .poll(() => page.evaluate(() => !!document.pointerLockElement))
    .toBe(true);
  console.log('Walk mode active');
  const scene = await page.evaluate(async (view) => {
    const v = window.__waterViewport,
      p = v.project;
    const { defaultWaterSettings, waterPreset } =
      await import('/src/core/water.ts');
    const heights = [...p.heights].sort((a, b) => a - b);
    const w = defaultWaterSettings(p);
    w.ocean.enabled = true;
    w.seaLevel = heights[Math.floor(heights.length * 0.35)] + 0.15;
    w.ocean.surface = waterPreset('tropical');
    w.ocean.surface.swellHeight = 0.08;
    w.ocean.surface.waveHeight = 0.04;
    p.water = w;
    p.view.water = false;
    const prepared = v.content.waterSystem.prepare(p);
    v.lighting.prepareWater();
    v.content.waterSystem.prepareGPU(prepared, v.renderer, v.camera, v.scene);
    v.content.waterSystem.apply(prepared);
    v.content.refreshView();
    v.camera.position.set(
      0,
      w.seaLevel + (view === 'canopy' ? 2.5 : 3.5),
      p.size * (view === 'canopy' ? 0.22 : 0.68),
    );
    v.camera.lookAt(
      0,
      w.seaLevel + 0.3,
      p.size * (view === 'canopy' ? -0.2 : 0.24),
    );
    return {
      name: p.name,
      size: p.size,
      foliage: p.foliage.length,
      seaLevel: w.seaLevel,
      adapter: v.gpuRenderer,
      buffer: [v.renderer.domElement.width, v.renderer.domElement.height],
      browser: navigator.userAgent,
      camera: v.camera.position.toArray(),
      view,
    };
  }, view);
  console.log('Water prepared', JSON.stringify(scene));
  if (!/RTX 5060/i.test(scene.adapter))
    throw new Error('Expected RTX 5060; actual adapter: ' + scene.adapter);
  for (const mode of ['off', 'sky', 'scenery']) {
    await page.evaluate((mode) => {
      const v = window.__waterViewport;
      v.content.waterSystem.visible = mode !== 'off';
      v.project.water.reflections = mode === 'scenery';
    }, mode);
    await page.waitForTimeout(2500);
    const data = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const v = window.__waterViewport,
            r = v.renderer,
            gl = r.getContext(),
            ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
          const original = v.lighting.render.bind(v.lighting),
            frames = [],
            gpu = [],
            pending = [];
          const timeout = setTimeout(() => {
            v.lighting.render = original;
            reject(
              new Error(
                'Water measurement timed out after ' +
                  frames.length +
                  ' frames.',
              ),
            );
          }, 60000);
          v.lighting.render = (camera) => {
            for (let i = pending.length - 1; i >= 0; i--)
              if (gl.getQueryParameter(pending[i], gl.QUERY_RESULT_AVAILABLE)) {
                if (!gl.getParameter(ext.GPU_DISJOINT_EXT))
                  gpu.push(
                    gl.getQueryParameter(pending[i], gl.QUERY_RESULT) / 1e6,
                  );
                gl.deleteQuery(pending[i]);
                pending.splice(i, 1);
              }
            const start = performance.now(),
              q = ext ? gl.createQuery() : null;
            if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
            original(camera);
            if (q) {
              gl.endQuery(ext.TIME_ELAPSED_EXT);
              pending.push(q);
            }
            frames.push({
              at: start,
              cpu: performance.now() - start,
              triangles: r.info.render.triangles,
            });
            if (frames.length >= 180) {
              clearTimeout(timeout);
              v.lighting.render = original;
              pending.forEach((q) => gl.deleteQuery(q));
              const percentile = (a, p) =>
                [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] ?? null;
              const series = (a) => ({
                median: percentile(a, 0.5),
                p95: percentile(a, 0.95),
              });
              resolve({
                frames: frames.length,
                fps:
                  (1000 * (frames.length - 1)) /
                  (frames.at(-1).at - frames[0].at),
                frameMs: series(
                  frames.slice(1).map((f, i) => f.at - frames[i].at),
                ),
                cpuSubmitMs: series(frames.map((f) => f.cpu)),
                gpuMs: series(gpu),
                gpuSamples: gpu.length,
                triangles: frames.at(-1).triangles,
                textures: r.info.memory.textures,
                waterError: v.lighting.animationError ?? null,
              });
            }
          };
        }),
    );
    results.push({ mode, ...data });
    console.log(mode, JSON.stringify(data));
    await page
      .locator('#viewport')
      .screenshot({ path: output.replace(/\.json$/, `-${mode}.png`) });
  }
  const report = {
    date: new Date().toISOString(),
    scene,
    results,
    errors,
    limits:
      'Static forest shoreline camera; 180 rendered frames per mode after warmup. GPU timer covers environment rendering passes. Does not measure input-to-display latency or promise performance for other views.',
  };
  await writeFile(output, JSON.stringify(report, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
}
