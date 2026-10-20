import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { seedEditorProject } from './seed-editor-project.mjs';
import { inspectorControl } from './inspector-controls.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createProject,
  serializeProject,
  defaultWaterSettings,
} from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';

test('web-ocean computes animated waves, shares synchronized tiles and releases its GPU resources', async ({
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
      defaultWaterSettings,
      defaultSpectralOceanSettings,
    } = await import('/__runtime_test/lib/core.js');
    const { TerrainScene, createTerrainRenderer, webOceanResources } =
      await import('/__runtime_test/lib/runtime.js');
    const renderer = await createTerrainRenderer();
    renderer.setSize(512, 384);
    document.body.replaceChildren(renderer.domElement);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const p = createProject(32, 256);
    p.heights.fill(-10);
    p.foliage = [];
    p.view.textureResolution = 256;
    p.water = defaultWaterSettings(p);
    p.water.ocean.enabled = true;
    p.water.ocean.renderer = 'web-ocean';
    p.water.ocean.spectral = {
      ...defaultSpectralOceanSettings(),
      windSpeed: 12,
    };
    p.water.ocean.surface.swellHeight = 1.5;
    p.water.ocean.surface.swellLength = 80;
    const terrain = new TerrainScene(p);
    await terrain.load(p, false);
    const other = new TerrainScene(structuredClone(p));
    await other.load(other.project, false);
    const scope = {};
    terrain.waterSystem.setWorldTile(0, 0, scope);
    other.waterSystem.setWorldTile(256, 0, scope);
    other.position.x = 256;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#abc5d4');
    const sun = new THREE.DirectionalLight(0xffffff, 4);
    sun.position.set(8, 10, 4);
    scene.add(
      terrain,
      other,
      sun,
      new THREE.HemisphereLight(0xb3d8ee, 0x1d3437, 2),
    );
    const camera = new THREE.PerspectiveCamera(55, 512 / 384, 0.1, 2000);
    camera.position.set(18, 5, 20);
    camera.lookAt(0, 0, -25);
    scene.updateMatrixWorld(true);
    const prepare = async (t) => {
      const candidate = t.waterSystem.prepare(t.project);
      try {
        await t.waterSystem.prepareGPU(candidate, renderer, camera, scene);
        t.waterSystem.apply(candidate);
        t.waterSystem.setWorldTile(t.position.x, 0, scope);
      } finally {
        candidate.dispose();
      }
    };
    await prepare(terrain);
    await prepare(other);
    const pausedProject = structuredClone(p);
    pausedProject.water.ocean.surface.speed = 0;
    const paused = new TerrainScene(pausedProject);
    await paused.load();
    paused.position.x = 512;
    scene.add(paused);
    paused.waterSystem.setWorldTile(512, 0, scope);
    await prepare(paused);
    const separateRate = webOceanResources(renderer).simulations;
    paused.removeFromParent();
    paused.dispose();
    const target = new THREE.RenderTarget(512, 384);
    const pixels = async () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const data = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        512,
        384,
      );
      renderer.setRenderTarget(null);
      return data;
    };
    terrain.update(0, [], camera);
    other.update(0, [], camera);
    const before = await pixels();
    for (let i = 0; i < 20; i++) {
      terrain.update(0.05, [], camera);
      other.update(0.05, [], camera);
      await pixels();
    }
    const after = await pixels();
    let changes = 0;
    for (let i = 0; i < before.length; i += 4)
      if (
        Math.abs(before[i] - after[i]) +
          Math.abs(before[i + 1] - after[i + 1]) +
          Math.abs(before[i + 2] - after[i + 2]) >
        6
      )
        changes++;
    const shared = webOceanResources(renderer);
    terrain.removeFromParent();
    terrain.dispose();
    await pixels();
    const surviving = webOceanResources(renderer);
    camera.position.x += 256;
    camera.lookAt(256, 0, -25);
    other.update(0, [], camera);
    renderer.render(scene, camera);
    window.oceanTest = { renderer, other, target, scene };
    return { shared, surviving, changes, validation, separateRate };
  });
  await page.screenshot({ path: info.outputPath('spectral-ocean.png') });
  await info.attach('ocean-resources', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  });
  expect(result.shared.simulations).toBe(1);
  expect(result.separateRate).toBe(2);
  expect(result.shared.bufferBytes).toBeGreaterThan(1_000_000);
  expect(result.surviving.simulations).toBe(1);
  expect(result.changes).toBeGreaterThan(100);
  expect(result.validation).toEqual([]);
  expect(errors).toEqual([]);
  const cleanup = await page.evaluate(async () => {
    const { webOceanResources } =
      await import('/__runtime_test/lib/runtime.js');
    const { renderer, other, target } = window.oceanTest;
    other.dispose();
    target.dispose();
    await renderer.dispose();
    return {
      ...webOceanResources(renderer),
      rendererBytes: renderer.info.memory.total,
    };
  });
  expect(cleanup).toEqual({ simulations: 0, bufferBytes: 0, rendererBytes: 0 });
});

test('spectral ocean renders with the terrain sky, shore and an independent pond', async ({
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
      defaultWaterSettings,
      defaultSpectralOceanSettings,
      waterPreset,
      environmentPreset,
    } = await import('/__runtime_test/lib/core.js');
    const {
      TerrainScene,
      TerrainEnvironment,
      createTerrainRenderer,
      webOceanResources,
    } = await import('/__runtime_test/lib/runtime.js');
    const renderer = await createTerrainRenderer();
    renderer.setSize(1280, 720);
    document.body.style.margin = '0';
    document.body.replaceChildren(renderer.domElement);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const p = createProject(64, 256);
    p.foliage = [];
    p.view.textureResolution = 256;
    for (let z = 0; z <= 64; z++)
      for (let x = 0; x <= 64; x++) {
        const r = ((x - 32) * 4) ** 2 + ((z - 32) * 4) ** 2;
        p.heights[z * 65 + x] =
          -8 + 20 * Math.exp(-r / 900) - 8 * Math.exp(-r / 45);
      }
    p.water = defaultWaterSettings(p);
    p.water.ocean.enabled = true;
    p.water.seaLevel = 0;
    p.water.ocean.renderer = 'web-ocean';
    p.water.ocean.spectral = {
      ...defaultSpectralOceanSettings(),
      quality: 'high',
      windSpeed: 10,
      fetch: 100000,
    };
    p.water.ocean.surface.swellHeight = 1.2;
    p.water.ocean.surface.swellLength = 70;
    p.water.bodies = [
      {
        id: 'pond',
        name: 'Inland pond',
        enabled: true,
        elevation: 5,
        extent: {
          kind: 'ellipse',
          x: 0,
          z: 0,
          radiusX: 4,
          radiusZ: 4,
          rotation: 0,
        },
        surface: waterPreset('pond'),
      },
    ];
    p.environment = environmentPreset('natural');
    p.environment.timeOfDay.playing = false;
    const terrain = new TerrainScene(p);
    await terrain.load();
    const scene = new THREE.Scene();
    scene.add(terrain);
    const camera = new THREE.PerspectiveCamera(55, 1280 / 720, 0.1, 3000);
    camera.position.set(68, 3, 85);
    camera.lookAt(0, 1, -10);
    const environment = new TerrainEnvironment(scene, renderer);
    await environment.load(p.environment, p);
    const candidate = terrain.waterSystem.prepare(p);
    try {
      await terrain.waterSystem.prepareGPU(candidate, renderer, camera, scene);
      terrain.waterSystem.apply(candidate);
    } finally {
      candidate.dispose();
    }
    for (let i = 0; i < 36; i++) {
      terrain.update(1 / 30, [], camera);
      environment.tick(1 / 30);
      environment.render(camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
    }
    window.oceanBeauty = { renderer, terrain, environment, camera, scene };
    return {
      validation,
      resources: webOceanResources(renderer),
      surfaces: terrain.waterSystem.surfaces.map((m) => m.userData.waterBody),
    };
  });
  await page.screenshot({ path: info.outputPath('spectral-coast.png') });
  expect(result.validation).toEqual([]);
  expect(result.resources.simulations).toBe(1);
  expect(result.surfaces).toEqual(['ocean', 'pond']);
  expect(errors).toEqual([]);
  await page.evaluate(() => {
    const { terrain, environment, renderer } = window.oceanBeauty;
    terrain.dispose();
    environment.dispose();
    renderer.dispose();
  });
});

test('ocean mode recovers from failed GPU preparation, then supports settings, undo and persistence', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await seedEditorProject(page);
  await page.addInitScript(() => {
    window.oceanBufferBytes = 0;
    const sizes = new WeakMap();
    const create = GPUDevice.prototype.createBuffer,
      destroy = GPUBuffer.prototype.destroy;
    GPUDevice.prototype.createBuffer = function (descriptor) {
      if (window.failOcean && descriptor.label === 'web-ocean spectrum 2') {
        window.failOcean = false;
        // Inject an asynchronous validation failure without replacing the
        // resources returned to Three or changing the committed scene.
        create.call(this, { size: 4, usage: 0 }).destroy();
      }
      const buffer = create.call(this, descriptor);
      if (descriptor.label?.startsWith('web-ocean ')) {
        sizes.set(buffer, descriptor.size);
        window.oceanBufferBytes += descriptor.size;
      }
      return buffer;
    };
    GPUBuffer.prototype.destroy = function () {
      window.oceanBufferBytes -= sizes.get(this) ?? 0;
      sizes.delete(this);
      return destroy.call(this);
    };
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 60000,
  });
  const p = createProject(32, 96);
  p.name = 'Spectral coast';
  p.foliage = [];
  p.view.textureResolution = 256;
  p.heights.fill(-3);
  p.water = defaultWaterSettings(p);
  p.water.ocean.enabled = true;
  p.water.ocean.surface.speed = 0;
  await page.locator('#file-open').setInputFiles({
    name: 'coast.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(p)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 60000,
  });
  const ready = () =>
    expect(page.locator('#preparation-status')).toBeHidden({ timeout: 60000 });
  const save = async (name) => {
    await ready();
    const downloading = page.waitForEvent('download');
    await page.locator('#save').click();
    const path = info.outputPath(name + '.terrain');
    await (await downloading).saveAs(path);
    return decodeDocument(await readFile(path));
  };
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await ready();
  const before = await save('before');
  await page.locator('[data-tab=water]').click();
  await page.evaluate(() => (window.failOcean = true));
  await page.locator('#water-renderer').selectOption('web-ocean');
  await expect(page.locator('#toast')).toContainText('previous water was kept');
  await expect(page.locator('#water-renderer')).toHaveValue('standard');
  await expect(page.locator('#redo')).toBeEnabled();
  expect(await page.evaluate(() => window.oceanBufferBytes)).toBe(0);
  expect(await save('failed')).toEqual(before);
  await page.locator('#water-renderer').selectOption('web-ocean');
  await ready();
  expect(await page.evaluate(() => window.oceanBufferBytes)).toBeGreaterThan(
    1_000_000,
  );
  await page.getByRole('tab', { name: 'Waves', exact: true }).click();
  await page.locator('#water-ocean-quality').selectOption('high');
  await ready();
  const wind = await inspectorControl(page, '#water-ocean-windSpeed');
  await wind.fill('14');
  await wind.press('Tab');
  await ready();
  const ocean = await save('ocean');
  expect(ocean.water.ocean.renderer).toBe('web-ocean');
  expect(ocean.water.ocean.spectral).toMatchObject({
    quality: 'high',
    windSpeed: 14,
  });
  await page.screenshot({ path: info.outputPath('ocean-controls.png') });
  await page.locator('#water-renderer').selectOption('standard');
  await ready();
  expect(await page.evaluate(() => window.oceanBufferBytes)).toBe(0);
  await page.locator('#undo').click();
  await ready();
  expect((await save('undone')).water).toEqual(ocean.water);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(p.name, {
    timeout: 60000,
  });
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 60000,
  });
  await page.locator('[data-tab=water]').click();
  await expect(page.locator('#water-renderer')).toHaveValue('web-ocean');
  expect((await save('restored')).water).toEqual(ocean.water);
  await writeFile(
    info.outputPath('spectral-editor.json'),
    JSON.stringify(
      {
        failurePreservedDocumentAndRedo: true,
        recovery: true,
        highDetail: true,
        undo: true,
        autosaveReload: true,
        errors,
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
});
