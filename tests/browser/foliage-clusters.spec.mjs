import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('CC0 distant tree clusters preserve wind, cutout shadows and pixels across sun directions', async ({
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
    const {
      createProject,
      editFoliageModels,
      environmentPreset,
      defaultFoliageSubsurface,
    } = await import('/__runtime_test/lib/core.js');
    const {
      TerrainScene,
      TerrainEnvironment,
      createTerrainRenderer,
      rendererDescription,
    } = await import('/__runtime_test/lib/runtime.js');
    const p = createProject(16, 256);
    p.heights.fill(0);
    p.foliage = [];
    p.view.water = false;
    p.view.textureResolution = 256;
    for (const id of ['ph-pine-b', 'ph-pine-b-mid', 'ph-pine-b-low']) {
      const data = new Uint8Array(
        await (await fetch('/foliage/photoreal/' + id + '.glb')).arrayBuffer(),
      );
      p.assets[id] = {
        name: id,
        data: 'data:model/gltf-binary;base64,' + data.toBase64(),
      };
    }
    const model = editFoliageModels(p.brushes[0], [])[0];
    Object.assign(model, {
      model: 'ph-pine-b',
      lods: [
        { model: 'ph-pine-b-mid', distance: 65, density: 1 },
        { model: 'ph-pine-b-low', distance: 150, density: 1 },
      ],
      cullDistance: 600,
      lodFadeDuration: 0.3,
      flexibility: { source: 'height', start: 0, end: 1, exponent: 4 },
      subsurface: defaultFoliageSubsurface(),
    });
    for (let z = -104; z <= 104; z += 16)
      for (let x = -104; x <= 104; x += 16)
        p.foliage.push({
          id: p.nextId++,
          brushId: p.brushes[0].id,
          modelId: model.id,
          x,
          z,
          scale: 1,
          rotation: (x + z) * 0.17,
        });
    p.wind.enabled = true;
    p.wind.strength = 2;
    const renderer = await createTerrainRenderer();
    renderer.setSize(640, 360);
    document.body.replaceChildren(renderer.domElement);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const camera = new THREE.PerspectiveCamera(55, 640 / 360, 0.1, 1000);
    camera.position.set(0, 8, 310);
    camera.lookAt(0, 7, 0);
    const target = new THREE.RenderTarget(640, 360);
    const reference = [],
      runs = [],
      comparisons = [];
    for (const clustered of [false, true]) {
      const terrain = new TerrainScene(p, { foliageClusters: clustered });
      await terrain.load();
      const scene = new THREE.Scene();
      scene.add(terrain);
      const environment = new TerrainEnvironment(scene, renderer);
      const settings = environmentPreset('natural');
      settings.timeOfDay.enabled = false;
      settings.temporalAA = false;
      settings.shadowResolution = 1024;
      settings.shadowDistance = 450;
      settings.fogEnabled = false;
      await environment.load(settings, p);
      const stats = [];
      for (const [index, azimuth] of [20, 150].entries()) {
        environment.set({ ...settings, sunAzimuth: azimuth }, p);
        for (let frame = 0; frame < 10; frame++) {
          await new Promise(requestAnimationFrame);
          terrain.update(1 / 30, [], camera);
          environment.updateCamera(camera);
          renderer.setRenderTarget(target);
          renderer.render(scene, camera);
          await renderer.backend.device.queue.onSubmittedWorkDone();
        }
        const pixels = new Uint8Array(
          await renderer.readRenderTargetPixelsAsync(target, 0, 0, 640, 360),
        );
        if (!clustered) reference.push(pixels);
        else {
          let sum = 0,
            max = 0,
            changed = 0;
          for (let i = 0; i < pixels.length; i++) {
            const delta = Math.abs(pixels[i] - reference[index][i]);
            sum += delta;
            max = Math.max(max, delta);
            if (delta) changed++;
          }
          comparisons.push({ mean: sum / pixels.length, max, changed });
        }
        stats.push({ ...terrain.foliage.viewStats });
      }
      renderer.setRenderTarget(null);
      environment.render(camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      runs.push({ clustered, stats });
      terrain.dispose();
      environment.dispose();
      await new Promise(queueMicrotask);
    }
    target.dispose();
    const adapter = rendererDescription(renderer);
    await renderer.dispose();
    return {
      runs,
      comparisons,
      validation,
      adapter,
      cleanup: renderer.info.memory.total,
    };
  });
  await info.attach('cluster-results', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  expect(result.runs[1].stats[0].batches).toBeLessThan(
    result.runs[0].stats[0].batches / 2,
  );
  expect(result.runs[1].stats[0].triangles).toBe(
    result.runs[0].stats[0].triangles,
  );
  expect(result.comparisons.every((image) => image.mean < 0.05)).toBe(true);
  expect(result.cleanup).toBe(0);
});
