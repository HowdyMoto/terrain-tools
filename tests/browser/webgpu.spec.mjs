import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('native WebGPU renders terrain, foliage, atmosphere and water; bakes PBR and survives resize', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await runtimePackagePage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const {
      createProject,
      generateTerrain,
      populateFoliage,
      defaultWaterSettings,
      waterPreset,
      environmentPreset,
    } = await import('/__runtime_test/lib/core.js');
    const {
      createTerrainRenderer,
      rendererDescription,
      TerrainScene,
      TerrainEnvironment,
      bakeTerrainSurface,
      exportTerrainGLB,
    } = await import('/__runtime_test/lib/runtime.js');
    const renderer = await createTerrainRenderer();
    const device = renderer.backend.device;
    const validation = [];
    device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    renderer.setSize(512, 384);
    document.body.replaceChildren(renderer.domElement);
    const p = createProject(32, 64);
    generateTerrain(p, 'flat');
    for (let z = 0; z <= 32; z++)
      for (let x = 0; x <= 32; x++) p.heights[z * 33 + x] = (x - 16) * 0.35;
    p.view.textureResolution = 256;
    for (const layer of p.materials) layer.tileSize = 64;
    p.view.water = false;
    populateFoliage(p, 'pine');
    p.water = defaultWaterSettings(p);
    p.water.ocean.enabled = true;
    p.water.seaLevel = 0;
    p.water.ocean.surface = waterPreset('tropical');
    p.environment = environmentPreset('natural');
    const terrain = new TerrainScene(p);
    await terrain.load();
    const scene = new THREE.Scene();
    scene.add(terrain);
    const camera = new THREE.PerspectiveCamera(50, 512 / 384, 0.1, 1000);
    camera.position.set(40, 35, 45);
    camera.lookAt(0, 0, 0);
    const environment = new TerrainEnvironment(scene, renderer);
    await environment.load(p.environment, p);
    camera.coordinateSystem = renderer.coordinateSystem;
    camera.updateProjectionMatrix();
    const projection = camera.projectionMatrix.clone();
    const render = async () => {
      await new Promise(requestAnimationFrame);
      terrain.update(0.016, [], camera);
      environment.render(camera);
      await device.queue.onSubmittedWorkDone();
    };
    for (let i = 0; i < 12; i++) await render();
    const projectionRestored = projection.equals(camera.projectionMatrix);
    const before = renderer.domElement.toDataURL();
    const baked = await bakeTerrainSurface(terrain, {
      renderer,
      resolution: 256,
    });
    const colors = baked.material.map.image.data;
    let min = 255,
      max = 0;
    for (let i = 0; i < colors.length; i += 4) {
      min = Math.min(min, colors[i]);
      max = Math.max(max, colors[i]);
    }
    const normal = [
      ...baked.material.normalMap.image.data.slice(
        128 * 256 * 4 + 128 * 4,
        128 * 256 * 4 + 128 * 4 + 3,
      ),
    ];
    const legacyRenderer = new THREE.WebGLRenderer();
    const bakeDifferences = [];
    for (const [variation, tileSize] of [
      [false, 64],
      [true, 64],
      [false, 4],
      [true, 4],
    ]) {
      for (const layer of terrain.project.materials) {
        layer.reduceTiling = variation;
        layer.tileSize = tileSize;
        layer.normalConvention = variation ? 'directx' : 'opengl';
      }
      const native =
        variation || tileSize === 4
          ? await bakeTerrainSurface(terrain, { renderer, resolution: 256 })
          : baked;
      const legacy = await bakeTerrainSurface(terrain, {
        renderer: legacyRenderer,
        resolution: 256,
      });
      for (const key of ['map', 'roughnessMap', 'normalMap']) {
        const a = native.material[key].image.data,
          b = legacy.material[key].image.data;
        const deltas = [];
        let max = 0,
          total = 0;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i] - b[i]);
          max = Math.max(max, d);
          total += d;
          deltas.push(d);
        }
        deltas.sort((a, b) => a - b);
        bakeDifferences.push({
          p99: deltas[Math.floor(deltas.length * 0.99)],
          variation,
          tileSize,
          map: key,
          max,
          mean: total / a.length,
        });
      }
      native.dispose();
      legacy.dispose();
    }
    legacyRenderer.dispose();
    legacyRenderer.forceContextLoss();
    const exported = await exportTerrainGLB(terrain, {
      renderer,
      surface: 'pbr',
      resolution: 256,
    });
    const magic = new DataView(exported).getUint32(0, true);
    renderer.setSize(640, 360);
    camera.aspect = 640 / 360;
    camera.updateProjectionMatrix();
    environment.invalidateHistory();
    for (let i = 0; i < 4; i++) await render();
    const resourceCycles = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await environment.load(
        {
          ...p.environment,
          temporalAA: false,
          shadowCascades: 1,
          ambientOcclusion: {
            ...p.environment.ambientOcclusion,
            enabled: false,
          },
        },
        p,
      );
      await render();
      await environment.load(p.environment, p);
      await render();
      await render();
      resourceCycles.push({ ...renderer.info.memory });
    }
    const changedAfterResize = before !== renderer.domElement.toDataURL();
    const adapter = rendererDescription(renderer),
      backend = renderer.backend.isWebGPUBackend;
    window.webgpuTest = { renderer, environment, terrain };
    return {
      resourceCycles,
      bakeDifferences,
      adapter,
      backend,
      validation,
      projectionRestored,
      changedAfterResize,
      min,
      max,
      normal,
      magic,
      bytes: exported.byteLength,
    };
  });
  await page.screenshot({
    path: info.outputPath('native-webgpu-water-forest.png'),
  });
  await info.attach('native-webgpu-results', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  await writeFile(
    info.outputPath('webgpu-correctness.json'),
    JSON.stringify(result, null, 2),
  );
  for (const map of result.bakeDifferences) {
    // Backend filtering differs most when stochastic offsets minify the maps.
    // Keep a tighter bound for ordinary, magnified and unvaried samples, and
    // constrain the stress case's average, 99th percentile and worst channel.
    const minifiedVariation = map.variation && map.tileSize === 4;
    expect(map.mean, map.map).toBeLessThan(minifiedVariation ? 0.5 : 0.01);
    expect(map.p99, map.map).toBeLessThanOrEqual(minifiedVariation ? 8 : 1);
    expect(map.max, map.map).toBeLessThanOrEqual(minifiedVariation ? 32 : 2);
  }
  for (const key of [
    'textures',
    'texturesSize',
    'geometries',
    'programs',
    'uniformBuffers',
    'uniformBuffersSize',
    'renderTargets',
  ]) {
    expect(result.resourceCycles[2][key], key).toBeLessThanOrEqual(
      result.resourceCycles[1][key],
    );
  }
  expect(result.backend).toBe(true);
  expect(result.adapter).toContain('WebGPU');
  expect(result.validation).toEqual([]);
  expect(errors).toEqual([]);
  expect(result.projectionRestored).toBe(true);
  expect(result.changedAfterResize).toBe(true);
  expect(result.max).toBeGreaterThan(result.min + 10);
  expect(result.normal[2]).toBeGreaterThan(180);
  expect(result.magic).toBe(0x46546c67);
  expect(result.bytes).toBeGreaterThan(10000);
  await page.evaluate(() => {
    const { renderer, environment, terrain } = window.webgpuTest;
    environment.dispose();
    terrain.dispose();
    renderer.dispose();
  });
});

test('editor explains unavailable WebGPU and keeps local-save recovery available', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'gpu', { value: undefined }),
  );
  await page.goto('/');
  await expect(page.locator('#renderer-unavailable')).toContainText(
    'WebGPU could not start',
  );
  await expect(
    page.getByRole('button', { name: 'Download locally saved project' }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Download locally saved project' })
    .click();
  await expect(page.locator('#renderer-unavailable')).toContainText(
    'No locally saved project',
  );
  expect(await page.locator('#app').evaluate((app) => app.inert)).toBe(true);
  await expect(page.locator('#viewport canvas')).toHaveCount(0);
});
