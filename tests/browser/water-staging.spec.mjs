import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('water compiles in its native overlay context while live frames continue, cancels, then retries', async ({
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
    const { createProject, environmentPreset, defaultWaterSettings } =
      await import('/__runtime_test/lib/core.js');
    const { TerrainScene, TerrainEnvironment, createTerrainRenderer } =
      await import('/__runtime_test/lib/runtime.js');
    const p = createProject(16, 64);
    p.heights.fill(0);
    p.foliage = [];
    p.props = [];
    p.view.water = false;
    p.view.textureResolution = 256;
    const renderer = await createTerrainRenderer();
    renderer.setSize(640, 360);
    document.body.replaceChildren(renderer.domElement);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const scene = new THREE.Scene(),
      terrain = new TerrainScene(p);
    await terrain.load();
    scene.add(terrain);
    const camera = new THREE.PerspectiveCamera(55, 640 / 360, 0.1, 400);
    camera.position.set(0, 8, 24);
    camera.lookAt(0, 0, 0);
    const environment = new TerrainEnvironment(scene, renderer),
      settings = environmentPreset('natural');
    settings.timeOfDay.enabled = false;
    settings.temporalAA = true;
    settings.shadowResolution = 1024;
    settings.ambientOcclusion.enabled = false;
    await environment.load(settings, p);
    const builds = [];
    renderer.debug.onNodeBuilderCreated = (_, record) => {
      if (record.material.userData.terrainWater)
        builds.push({
          key: record.initialCacheKey,
          material: record.getMaterialCacheKey(),
          dynamic: record.getDynamicCacheKey(),
          context: record.context.id,
          mrt: record.context.mrt?.id,
          target: record.context.renderTarget?.id,
          textures: record.context.textures?.map((t) => t.id),
          pass: environment.gpuPipeline.pass.renderTarget.id,
          lights: record.lightsNode.id,
          version: record.material.version,
          receive: record.object.receiveShadow,
          geometry: record.getGeometryCacheKey(),
          program: record.material.customProgramCacheKey(),
        });
    };
    let frames = 0;
    const frame = async () => {
      await new Promise(requestAnimationFrame);
      environment.updateCamera(camera);
      environment.render(camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      frames++;
    };
    for (let i = 0; i < 6; i++) await frame();
    const q = structuredClone(p);
    q.view.water = true;
    q.water = defaultWaterSettings(q);
    q.water.ocean.enabled = true;
    q.water.seaLevel = 0.4;
    const candidate = new TerrainScene(q);
    await candidate.load();
    const source = JSON.stringify(p);
    const original = renderer.compileAsync;
    let entered = false,
      release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    renderer.compileAsync = function (...args) {
      const pending = original.apply(this, args);
      entered = true;
      return Promise.all([pending, gate]).then(() => {});
    };
    const abort = new AbortController();
    let cancelled = false;
    const pending = environment
      .stageWater(candidate.waterSystem, camera, abort.signal)
      .catch((e) => {
        cancelled = e.name === 'AbortError';
      });
    while (!entered) await frame();
    const before = frames;
    for (let i = 0; i < 4; i++) await frame();
    const liveFrames = frames - before,
      restored =
        renderer.getRenderTarget() === null && renderer.getMRT() === null;
    abort.abort();
    release();
    await pending;
    renderer.compileAsync = original;
    let done = false,
      failure;
    const retry = environment
      .stageWater(candidate.waterSystem, camera, new AbortController().signal)
      .catch((e) => {
        failure = String(e);
      })
      .finally(() => {
        done = true;
      });
    while (!done) await frame();
    await retry;
    const warmCount = builds.length;
    let coldWaterBuilds = 0,
      coldWaterPipelines = 0;
    const createPipeline = renderer.backend.createRenderPipeline;
    renderer.backend.createRenderPipeline = function (object, ...args) {
      if (object.material.userData.terrainWater) coldWaterPipelines++;
      return createPipeline.call(this, object, ...args);
    };
    renderer.debug.onNodeBuilderCreated = (_, record) => {
      if (record.material.userData.terrainWater) {
        coldWaterBuilds++;
        builds.push({
          key: record.initialCacheKey,
          material: record.getMaterialCacheKey(),
          dynamic: record.getDynamicCacheKey(),
          context: record.context.id,
          mrt: record.context.mrt?.id,
          target: record.context.renderTarget?.id,
          textures: record.context.textures?.map((t) => t.id),
          pass: environment.gpuPipeline.pass.renderTarget.id,
          lights: record.lightsNode.id,
          version: record.material.version,
          receive: record.object.receiveShadow,
          geometry: record.getGeometryCacheKey(),
          program: record.material.customProgramCacheKey(),
        });
      }
    };
    scene.add(candidate.waterSystem);
    environment.invalidateHistory();
    await frame();
    await frame();
    const report = {
      builds,
      warmCount,
      cancelled,
      restored,
      liveFrames,
      failure,
      coldWaterBuilds,
      coldWaterPipelines,
      unchanged: source === JSON.stringify(p),
      validation,
    };
    candidate.waterSystem.removeFromParent();
    candidate.dispose();
    terrain.dispose();
    environment.dispose();
    renderer.dispose();
    report.cleanup = { ...renderer.info.memory };
    return report;
  });
  await info.attach('water-staging', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  expect(result.failure).toBeUndefined();
  expect(result.cancelled).toBe(true);
  expect(result.restored).toBe(true);
  expect(result.liveFrames).toBe(4);
  expect(result.unchanged).toBe(true);
  expect(result.warmCount).toBeGreaterThan(0);
  expect(result.coldWaterBuilds).toBe(0);
  expect(result.coldWaterPipelines).toBe(0);
  expect(result.cleanup.textures).toBe(0);
  expect(result.cleanup.uniformBuffers).toBe(0);
});
