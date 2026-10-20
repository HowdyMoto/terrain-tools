import { test, expect } from '@playwright/test';

for (const profile of ['', '?impostors&wide-clusters']) {
  test(`native WebGPU streams prepared forest and coast, then releases the world (${profile ? 'generated distant trees' : 'mesh foliage'})`, async ({
    page,
  }, info) => {
    // This is a cold shader/asset correctness run, not a frame-time acceptance test.
    test.setTimeout(720000);
    const errors = [];
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.log('World page error:', e.message.slice(0, 1600));
    });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.addInitScript(() => {
      window.gpuValidationErrors = [];
      addEventListener(
        'error',
        (e) => (window.worldInitializationError = e.message),
      );
      addEventListener(
        'unhandledrejection',
        (e) => (window.worldInitializationError = String(e.reason)),
      );
      const request = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (...args) {
        const device = await request.apply(this, args);
        device.addEventListener('uncapturederror', (e) =>
          window.gpuValidationErrors.push(e.error.message),
        );
        return device;
      };
    });
    await page.goto('/world.html' + profile);
    await page.waitForFunction(
      () => window.worldExample || window.worldInitializationError,
      null,
      {
        timeout: 180000,
      },
    );
    expect(
      await page.evaluate(() => window.worldInitializationError),
    ).toBeUndefined();
    const views = [];
    for (const name of ['forest', 'open', 'coast']) {
      const result = await page.evaluate(async (name) => {
        const api = window.worldExample;
        const started = performance.now();
        api.view(name);
        await Promise.race([
          api.ready(),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    name +
                      ' world loading timed out: ' +
                      JSON.stringify(api.world.stats),
                  ),
                ),
              180000,
            ),
          ),
        ]);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        await Promise.race([
          api.renderer.backend.device.queue.onSubmittedWorkDone(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('World GPU queue timed out')),
              30000,
            ),
          ),
        ]);
        return {
          readinessMs: performance.now() - started,
          backend: api.renderer.backend.isWebGPUBackend,
          adapter: api.adapter,
          stats: api.world.stats,
          generatedTrees: api.world.options.foliageImpostors?.size ?? 0,
          nearbyCellSize: api.world.options.foliageClusters?.nearbyCellSize,
          failures: [...api.world.streaming.errors].map(([id, e]) => [
            id,
            String(e),
          ]),
          validation: window.gpuValidationErrors,
        };
      }, name);
      console.log(
        'Prepared WebGPU view:',
        name,
        Math.round(result.readinessMs),
        'ms',
      );
      expect(result.backend).toBe(true);
      expect(result.generatedTrees).toBe(profile ? 1 : 0);
      if (profile) expect(result.nearbyCellSize).toBe(128);
      expect(result.failures).toEqual([]);
      expect(result.validation).toEqual([]);
      expect(result.stats.residentTiles).toBeGreaterThan(0);
      expect(result.stats.residentTiles).toBeLessThanOrEqual(12);
      views.push({ name, ...result });
      await page.screenshot({
        path: info.outputPath('webgpu-' + name + '.png'),
      });
    }
    await page.evaluate(() => window.worldExample.dispose());
    expect(errors).toEqual([]);
    await info.attach('world-webgpu-correctness', {
      body: JSON.stringify(views, null, 2),
      contentType: 'application/json',
    });
  });
}
