import { chromium, expect as baseExpect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
// Development-server instrumentation only: the application exposes no debug API.
// Measures handled mouse input to a polled GPU fence, not display scanout latency.
const projectPath = process.argv[2];
if (!projectPath)
  throw new Error(
    'Usage: node scripts/benchmark-walk.mjs <project.terrain> [report.json] [dev URL]',
  );
const outputPath = process.argv[3] ?? '.qa/walk-latency.json';
const devUrl = process.argv[4] ?? 'http://127.0.0.1:5174';
const expect = baseExpect.configure({ timeout: 120000 });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--force-high-performance-gpu'],
});
const all = [];
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', (e) => console.log('ERROR', e.message));
    await page.route('**/src/main.ts*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()) + '\nwindow.__viewport = viewport;',
      });
    });
    await page.goto(devUrl);
    await expect(page.locator('#app')).not.toHaveAttribute('inert');
    await page.locator('#file-open').setInputFiles(projectPath);
    await expect(page.locator('#toast')).toHaveText('Project loaded.');
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
    await page.waitForTimeout(3000);
    console.log(
      'START',
      dpr,
      await page.evaluate(() => ({
        gpu: __viewport.gpuRenderer,
        canvas: [
          __viewport.renderer.domElement.width,
          __viewport.renderer.domElement.height,
        ],
      })),
    );
    await page.evaluate(() => {
      const viewport = window.__viewport,
        gl = viewport.renderer.getContext();
      const data = (window.__latency = {
        frames: [],
        events: [],
        gpu: [],
        pending: [],
        lastInput: null,
      });
      const original = viewport.lighting.render.bind(viewport.lighting);
      document.addEventListener('mousemove', (e) => {
        if (!document.pointerLockElement) return;
        const event = {
          at: performance.now(),
          age: performance.now() - e.timeStamp,
          x: e.movementX,
          y: e.movementY,
          q: viewport.camera.quaternion.toArray(),
        };
        data.events.push(event);
        data.lastInput = event;
      });
      viewport.lighting.render = (camera) => {
        const start = performance.now();
        for (const pending of [...data.pending]) {
          const status = gl.clientWaitSync(pending.sync, 0, 0);
          if (
            status === gl.ALREADY_SIGNALED ||
            status === gl.CONDITION_SATISFIED
          ) {
            data.gpu.push({
              ms: start - pending.start,
              inputMs: pending.inputAt ? start - pending.inputAt : null,
            });
            gl.deleteSync(pending.sync);
            data.pending.splice(data.pending.indexOf(pending), 1);
          }
        }
        original(camera);
        data.pending.push({
          sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0),
          start,
          inputAt: data.lastInput?.at,
        });
        data.frames.push({
          at: start,
          cpu: performance.now() - start,
          pending: data.pending.length,
          inputAge: data.lastInput ? start - data.lastInput.at : null,
          q: camera.quaternion.toArray(),
        });
        data.lastInput = null;
      };
    });
    for (let i = 0; i < 150; i++) {
      await page.mouse.move(
        960 + Math.round(Math.sin(i / 15) * 220),
        594 + Math.round(Math.sin(i / 30) * 15),
      );
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    await page.waitForTimeout(1000);
    const data = await page.evaluate(() => {
      const { frames, events, gpu } = __latency;
      const percentile = (values, p) =>
        values.sort((a, b) => a - b)[Math.floor(values.length * p)] ?? null;
      const series = (values) => ({
        median: percentile([...values], 0.5),
        p95: percentile([...values], 0.95),
        max: Math.max(...values),
      });
      return {
        gpu: __viewport.gpuRenderer,
        canvas: [
          __viewport.renderer.domElement.width,
          __viewport.renderer.domElement.height,
        ],
        fps: (1000 * (frames.length - 1)) / (frames.at(-1).at - frames[0].at),
        submitMs: series(frames.map((f) => f.cpu)),
        gpuCompleteMs: series(gpu.map((f) => f.ms)),
        eventDeliveryMs: series(events.map((e) => e.age)),
        inputToSubmitMs: series(
          frames.filter((f) => f.inputAge !== null).map((f) => f.inputAge),
        ),
        inputToGPUCompleteMs: series(
          gpu.filter((f) => f.inputMs !== null).map((f) => f.inputMs),
        ),
        maxPending: Math.max(...frames.map((f) => f.pending)),
        frames: frames.length,
        events: events.length,
      };
    });
    all.push({ dpr, ...data });
    console.log('RESULT', JSON.stringify(all.at(-1)));
    await context.close();
  }
} finally {
  await browser.close();
}
await writeFile(outputPath, JSON.stringify(all, null, 2));
