import { test, expect } from '@playwright/test';
import sharp from 'sharp';

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
    for (const name of ['forest', 'open', 'coast', 'aerial']) {
      const result = await page.evaluate(async (name) => {
        const api = window.worldExample;
        const started = performance.now();
        if (name === 'aerial') api.move(415, 606, 69);
        else api.view(name);
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
        if (name === 'aerial') {
          for (let i = 0; i < 12; i++) {
            api.move(415 + i * 0.8, 606 + i * 0.3, 69 + i * 0.2);
            await new Promise(requestAnimationFrame);
            await api.renderer.backend.device.queue.onSubmittedWorkDone();
          }
        }
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
          ground: api.world.tiles.map((tile) => ({
            normals:
              tile.terrainMaterial.uniforms.layerNormalStrength.value.toArray(),
            heightBlend:
              tile.terrainMaterial.uniforms.layerBlend.value.toArray(),
          })),
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
      expect(result.ground.length).toBeGreaterThan(0);
      for (const ground of result.ground) {
        expect(ground.normals).toEqual([0, 0, 0, 0]);
        expect(ground.heightBlend).toEqual([0, 0, 0, 0]);
      }
      views.push({ name, ...result });
      await page.screenshot({
        path: info.outputPath('webgpu-' + name + '.png'),
      });
    }
    // Freeze simulation, not anti-aliasing. Leaf coverage must converge while
    // the temporal jitter sequence continues, including after an aerial move.
    await page.evaluate(async () => {
      const a = window.worldExample;
      a.renderer.setAnimationLoop(null);
      await a.renderer.backend.device.queue.onSubmittedWorkDone();
      for (let i = 0; i < 90; i++) {
        if (i < 30) a.world.update(a.camera, 1 / 30, innerHeight);
        a.environment.updateCamera(a.camera);
        a.environment.render(a.camera);
        await a.renderer.backend.device.queue.onSubmittedWorkDone();
      }
    });
    const samples = [];
    const viewport = page.viewportSize();
    const left = Math.ceil(viewport.width * 0.4);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(async () => {
        const a = window.worldExample;
        a.environment.render(a.camera);
        await a.renderer.backend.device.queue.onSubmittedWorkDone();
      });
      const png = await page.screenshot();
      if (i === 0 || i === 7)
        await info.attach('stationary-frame-' + i, {
          body: png,
          contentType: 'image/png',
        });
      samples.push(
        await sharp(png)
          .extract({
            left,
            top: 0,
            width: viewport.width - left,
            height: viewport.height,
          })
          .removeAlpha()
          .raw()
          .toBuffer(),
      );
    }
    let difference = 0,
      changed = 0;
    for (let f = 1; f < samples.length; f++)
      for (let i = 0; i < samples[f].length; i++) {
        const delta = Math.abs(samples[f][i] - samples[f - 1][i]);
        difference += delta;
        if (delta > 3) changed++;
      }
    const channels = samples[0].length * (samples.length - 1);
    const hdr = await page.evaluate(async () => {
      const a = window.worldExample,
        pipeline = a.environment.gpuPipeline;
      const temporal = pipeline.effects.find((effect) => effect.isTRAANode);
      const raw = temporal.beautyNode.renderTarget;
      const filtered = pipeline.effects
        .filter((effect) => effect.isRTTNode)
        .at(-1).renderTarget;
      const width = raw.width,
        height = raw.height;
      const left = Math.ceil(width * 0.4);
      // RGBA16F full rows are aligned for the fixed 1440px viewport. Compare
      // the actual mixed temporal result before sharpening/tone conversion to
      // its same-frame jittered input, rather than imposing an exposure limit.
      const half = (x) => {
        const exponent = (x >> 10) & 31,
          mantissa = x & 1023;
        return (
          (x & 32768 ? -1 : 1) *
          (exponent === 0
            ? mantissa * 2 ** -24
            : (1 + mantissa / 1024) * 2 ** (exponent - 15))
        );
      };
      let previous,
        count = 0;
      const sums = [0, 0];
      for (let f = 0; f < 12; f++) {
        a.environment.render(a.camera);
        await a.renderer.backend.device.queue.onSubmittedWorkDone();
        const images = await Promise.all(
          [raw, filtered].map((target) =>
            a.renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height),
          ),
        );
        if (previous) {
          for (let y = 0; y < height; y += 2)
            for (let x = left; x < width; x += 2)
              for (let c = 0; c < 3; c++) {
                const i = (y * width + x) * 4 + c;
                for (let k = 0; k < 2; k++)
                  sums[k] += Math.abs(
                    half(images[k][i]) - half(previous[k][i]),
                  );
                count++;
              }
        }
        previous = images;
      }
      return {
        rawMeanDelta: sums[0] / count,
        filteredMeanDelta: sums[1] / count,
        retainedVariation: sums[1] / sums[0],
      };
    });
    const stationary = {
      meanDelta: difference / channels,
      changedFraction: changed / channels,
      hdr,
    };
    console.log('Stationary foliage:', stationary);
    await info.attach('stationary-foliage.json', {
      body: JSON.stringify(stationary),
      contentType: 'application/json',
    });
    expect(hdr.rawMeanDelta).toBeGreaterThan(0.001);
    expect(hdr.retainedVariation).toBeLessThan(0.25);
    await page.evaluate(() => window.worldExample.dispose());
    expect(errors).toEqual([]);
    await info.attach('world-webgpu-correctness', {
      body: JSON.stringify(views, null, 2),
      contentType: 'application/json',
    });
  });
}
