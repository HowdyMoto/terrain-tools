import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('camera history resets retain compiled native scene programs and seed fresh temporal pixels', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { createProject, environmentPreset, editFoliageModels } =
      await import('/__runtime_test/lib/core.js');
    const {
      TerrainScene,
      TerrainEnvironment,
      createTerrainRenderer,
      shaderCacheStats,
    } = await import('/__runtime_test/lib/runtime.js');
    const p = createProject(16, 64);
    p.heights.fill(0);
    const plant = editFoliageModels(p.brushes[0], [])[0];
    plant.color = '#ff0000';
    p.foliage = [
      {
        id: p.nextId++,
        brushId: p.brushes[0].id,
        modelId: plant.id,
        x: 0,
        z: 0,
        scale: 1,
        rotation: 0,
      },
    ];
    p.props = [];
    p.view.water = false;
    p.view.textureResolution = 256;
    const r = await createTerrainRenderer();
    r.setSize(640, 360);
    document.body.replaceChildren(r.domElement);
    const validation = [];
    r.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const scene = new THREE.Scene(),
      terrain = new TerrainScene(p);
    await terrain.load();
    scene.add(terrain);
    const geometry = new THREE.BoxGeometry(4, 8, 4),
      material = new THREE.MeshStandardMaterial({ color: '#ff2200' }),
      box = new THREE.Mesh(geometry, material);
    box.position.set(-12, 4, 0);
    box.castShadow = box.receiveShadow = true;
    scene.add(box);
    const camera = new THREE.PerspectiveCamera(55, 640 / 360, 0.1, 300);
    camera.position.set(0, 12, 40);
    camera.lookAt(0, 3, 0);
    const e = new TerrainEnvironment(scene, r),
      settings = environmentPreset('natural');
    settings.temporalAA = true;
    settings.shadowResolution = 1024;
    settings.timeOfDay.enabled = false;
    settings.ambientOcclusion.enabled = false;
    await e.load(settings, p);
    let builds = 0;
    r.debug.onNodeBuilderCreated = () => builds++;
    const frame = async () => {
      await new Promise(requestAnimationFrame);
      terrain.update(0, [], camera);
      e.updateCamera(camera);
      e.render(camera);
      await r.backend.device.queue.onSubmittedWorkDone();
    };
    for (let i = 0; i < 12; i++) await frame();
    const warmBuilds = builds,
      memory = { ...r.info.memory };
    const pipeline = e.gpuPipeline,
      pass = pipeline.pass,
      post = pipeline.post;
    box.position.x = 12;
    e.invalidateHistory();
    await frame();
    const resetBuilds = builds - warmBuilds;
    // The reset resolve must contain this frame's scene input, not clipped old red coverage.
    const temporal = pipeline.effects.find((effect) => effect.isTRAANode);
    const fresh = new Uint16Array(
      await r.readRenderTargetPixelsAsync(
        temporal._resolveRenderTarget,
        0,
        0,
        640,
        360,
      ),
    );
    const history = new Uint16Array(
      await r.readRenderTargetPixelsAsync(
        temporal._historyRenderTarget,
        0,
        0,
        640,
        360,
      ),
    );
    let difference = 0;
    for (let i = 0; i < fresh.length; i++)
      if (fresh[i] !== history[i]) difference++;
    for (let i = 0; i < 5; i++) {
      e.invalidateHistory();
      await frame();
    }
    const retained = pass === pipeline.pass && post === pipeline.post;
    const repeatedBuilds = builds - warmBuilds;
    r.setSize(800, 450);
    camera.aspect = 800 / 450;
    camera.updateProjectionMatrix();
    e.invalidateHistory();
    await frame();
    await frame();
    const resizedPass = pass === pipeline.pass;
    scene.remove(box);
    geometry.dispose();
    material.dispose();
    const placements = p.foliage;
    p.foliage = [];
    terrain.rebuildFoliage();
    await frame();
    const beforeReplacement = builds;
    p.foliage = placements;
    plant.color = '#0000ff';
    terrain.rebuildFoliage();
    e.invalidateHistory();
    await frame();
    const replacementBuilds = builds - beforeReplacement;
    const cached = shaderCacheStats(r);
    const pixels = new Uint16Array(
      await r.readRenderTargetPixelsAsync(pass.renderTarget, 0, 0, 800, 450),
    );
    const at = (225 * 800 + 400) * 4;
    const replacementColor = [0, 1, 2].map((i) =>
      THREE.DataUtils.fromHalfFloat(pixels[at + i]),
    );
    const report = {
      warmBuilds,
      resetBuilds,
      repeatedBuilds,
      retained,
      resizedPass,
      difference,
      memory,
      after: { ...r.info.memory },
      validation,
      replacementBuilds,
      cached,
      replacementColor,
    };
    e.dispose();
    terrain.dispose();

    r.dispose();
    report.disposedCache = shaderCacheStats(r);
    return report;
  });
  await info.attach('temporal-reset', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  expect(result.resetBuilds).toBe(0);
  expect(result.repeatedBuilds).toBe(0);
  expect(result.retained).toBe(true);
  expect(result.resizedPass).toBe(true);
  expect(result.difference).toBe(0);
  expect(result.replacementBuilds).toBe(0);
  expect(result.cached.hits).toBeGreaterThan(0);
  expect(result.cached.retainedPrograms).toBeLessThanOrEqual(32);
  expect(result.cached.retainedSourceBytes).toBeLessThanOrEqual(8 * 1024 ** 2);
  expect(result.disposedCache.programs).toBe(0);
  expect(result.replacementColor[2]).toBeGreaterThan(
    result.replacementColor[0] * 2,
  );
});
