import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('native scene capture preserves cutout MSAA coverage with water and after temporal toggles', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await runtimePackagePage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { createProject, environmentPreset, defaultWaterSettings } =
      await import('/__runtime_test/lib/core.js');
    const { TerrainScene, TerrainEnvironment, createTerrainRenderer } =
      await import('/__runtime_test/lib/runtime.js');
    const renderer = await createTerrainRenderer();
    renderer.setSize(512, 512);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const p = createProject(8, 16);
    p.heights.fill(0);
    p.foliage = [];
    p.props = [];
    p.view.textureResolution = 256;
    p.water = defaultWaterSettings(p);
    p.water.seaLevel = -5;
    p.water.ocean.enabled = true;
    const terrain = new TerrainScene(p);
    await terrain.load();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    const pixels = new Uint8Array(32 * 32 * 4);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++)
        pixels.set(
          [70, 180, 45, Math.abs(x - 15.5) + Math.abs(y - 15.5) < 14 ? 255 : 0],
          (y * 32 + x) * 4,
        );
    const map = new THREE.DataTexture(pixels, 32, 32);
    map.minFilter = map.magFilter = THREE.LinearFilter;
    map.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({
      map,
      alphaTest: 0.5,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.PlaneGeometry(2.5, 2.5).rotateZ(0.231);
    const leaf = new THREE.Mesh(geometry, material);
    leaf.position.set(0, 2, 0);
    scene.add(leaf);
    const camera = new THREE.OrthographicCamera(-2, 2, 4, 0, 0.1, 50);
    camera.position.set(0, 0, 8);
    camera.lookAt(0, 0, 0);
    const direct = new THREE.RenderTarget(512, 512, {
      type: THREE.HalfFloatType,
      samples: renderer.samples,
    });
    renderer.setRenderTarget(direct);
    renderer.render(scene, camera);
    const baseline = await renderer.readRenderTargetPixelsAsync(
      direct,
      0,
      0,
      512,
      512,
    );
    renderer.setRenderTarget(null);
    const environment = new TerrainEnvironment(scene, renderer);
    const settings = environmentPreset('natural');
    Object.assign(settings, {
      mode: 'none',
      backgroundColor: '#ffffff',
      shadows: false,
      temporalAA: false,
      temporalSharpness: 0,
      fogEnabled: false,
    });
    settings.timeOfDay.enabled = false;
    settings.ambientOcclusion.enabled = false;
    const edges = (data) => {
      let fractional = 0,
        dark = 0;
      const leafRed = 70 / 255;
      for (let i = 0; i < data.length; i += 4) {
        const red = THREE.DataUtils.fromHalfFloat(data[i]);
        if (red > leafRed + 0.02 && red < 0.98) fractional++;
        if (red < leafRed - 0.02) dark++;
      }
      return { fractional, dark };
    };
    const variants = [];
    for (const [name, water, temporal] of [
      ['dry', false, false],
      ['water', true, false],
      ['temporal', true, true],
      ['return-msaa', true, false],
      ['display-scale-2', true, false],
    ]) {
      if (name === 'display-scale-2') {
        renderer.setPixelRatio(2);
        renderer.setSize(256, 256); // Same physical pixel reference, different display scale.
      }
      if (water && !terrain.waterSystem.parent) scene.add(terrain.waterSystem);
      settings.temporalAA = temporal;
      await environment.load(settings, p);
      environment.render(camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const capture = environment.gpuPipeline.water.target;
      const data = await renderer.readRenderTargetPixelsAsync(
        capture,
        0,
        0,
        512,
        512,
      );
      variants.push({ name, samples: capture.samples, ...edges(data) });
    }
    const stats = {
      baseline: edges(baseline),
      variants,
      expectedSamples: renderer.samples,
      validation,
    };
    environment.dispose();
    direct.dispose();
    terrain.dispose();
    geometry.dispose();
    material.dispose();
    map.dispose();
    renderer.dispose();
    return stats;
  });
  await writeFile(
    info.outputPath('foliage-edges.json'),
    JSON.stringify(result, null, 2),
  );
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  expect(result.baseline.fractional).toBeGreaterThan(100);
  for (const v of result.variants.filter((v) => v.name !== 'temporal')) {
    expect(v.samples, v.name).toBe(result.expectedSamples);
    expect(v.fractional, v.name).toBeGreaterThan(
      result.baseline.fractional * 0.9,
    );
    expect(v.dark, v.name).toBe(0);
  }
});
