import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';
test('native foliage shares node programs across spatial batches', async ({
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
    const { createProject, editFoliageModels } =
      await import('/__runtime_test/lib/core.js');
    const { TerrainScene, createTerrainRenderer } =
      await import('/__runtime_test/lib/runtime.js');
    const p = createProject(8, 256);
    p.foliage = [];
    p.wind.enabled = false;
    const model = editFoliageModels(p.brushes[0], [])[0];
    model.wind = 0;
    model.flexibility = { source: 'height', start: 0, end: 1, exponent: 2 };
    for (let z = -96; z <= 96; z += 48)
      for (let x = -96; x <= 96; x += 48)
        p.foliage.push({
          id: p.nextId++,
          brushId: p.brushes[0].id,
          modelId: model.id,
          x,
          z,
          scale: 3,
          rotation: 0,
        });
    const terrain = new TerrainScene(p);
    terrain.rebuildFoliage();
    const scene = new THREE.Scene();
    scene.add(
      terrain.foliage,
      new THREE.HemisphereLight(0xffffff, 0x444444, 3),
    );
    const camera = new THREE.OrthographicCamera(
      -128,
      128,
      128,
      -128,
      0.1,
      1000,
    );
    camera.position.set(0, 240, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const renderer = await createTerrainRenderer();
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    renderer.setSize(512, 512);
    document.body.append(renderer.domElement);
    const builds = [];
    renderer.debug.onNodeBuilderCreated = (b) =>
      builds.push({
        type: b.material.type,
        id: b.material.id,
        instanced: b.object.isInstancedMesh,
        count: b.object.count,
      });
    renderer.render(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const first = builds.length;
    renderer.render(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const secondBuilds = builds.length - first;
    const target = new THREE.RenderTarget(512, 512);
    const cells = async () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        512,
        512,
      );
      renderer.setRenderTarget(null);
      const occupied = [];
      for (let z = -96; z <= 96; z += 48)
        for (let x = -96; x <= 96; x += 48) {
          let count = 0;
          // Readback orientation does not affect this symmetric grid.
          for (let v = (z + 128) * 2 - 24; v < (z + 128) * 2 + 24; v++)
            for (let u = (x + 128) * 2 - 24; u < (x + 128) * 2 + 24; u++) {
              const i = (v * 512 + u) * 4;
              if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 10) count++;
            }
          occupied.push(count);
        }
      return occupied;
    };
    const before = await cells();
    const moved = terrain.foliage.children.filter((m) =>
      m.userData.instanceIds.includes(p.foliage[0].id),
    );
    const originals = moved.map((m) =>
      new THREE.Matrix4().fromArray(m.instanceMatrix.array),
    );
    moved.forEach((m) => {
      m.setMatrixAt(0, new THREE.Matrix4().makeTranslation(500, 0, 500));
      m.instanceMatrix.needsUpdate = true;
    });
    const after = await cells();
    moved.forEach((m, i) => {
      m.setMatrixAt(0, originals[i]);
      m.instanceMatrix.needsUpdate = true;
    });
    const attribute = moved[0].geometry.getAttribute('terrainInstance0');
    const secondRenderer = await createTerrainRenderer();
    secondRenderer.setSize(128, 128);
    secondRenderer.render(scene, camera);
    await secondRenderer.backend.device.queue.onSubmittedWorkDone();
    const stableAttribute =
      attribute === moved[0].geometry.getAttribute('terrainInstance0');
    const restored = await cells();
    await secondRenderer.dispose();
    target.dispose();
    renderer.render(scene, camera);
    const result = {
      batches: terrain.foliage.children.length,
      materials: new Set(terrain.foliage.children.map((m) => m.material)).size,
      firstBuilds: first,
      secondBuilds,
      builds,
      occupied: before.filter((n) => n > 30).length,
      movedOccupied: after.filter((n) => n > 30).length,
      restoredOccupied: restored.filter((n) => n > 30).length,
      stableAttribute,
      validation,
    };
    window.batchTest = { renderer, terrain, scene, camera };
    return result;
  });
  await info.attach('native-batching', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('native-batches.png') });
  expect(errors).toEqual([]);
  expect(result.batches).toBeGreaterThan(20);
  expect(result.firstBuilds).toBeLessThan(10);
  expect(result.secondBuilds).toBe(0);
  expect(result.occupied).toBe(25);
  expect(result.movedOccupied).toBe(24);
  expect(result.restoredOccupied).toBe(25);
  expect(result.stableAttribute).toBe(true);
  expect(result.validation).toEqual([]);
  await page.evaluate(async () => {
    window.batchTest.terrain.dispose();
    await window.batchTest.renderer.dispose();
  });
});

test('removing foliage keeps shared shadow buffers alive for other casters', async ({
  page,
}) => {
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { createProject } = await import('/__runtime_test/lib/core.js');
    const { TerrainScene, createTerrainRenderer } =
      await import('/__runtime_test/lib/runtime.js');
    const project = createProject(8, 64);
    project.foliage = [
      {
        id: 1,
        brushId: project.brushes[0].id,
        x: 0,
        z: 0,
        scale: 2,
        rotation: 0,
      },
    ];
    project.wind.enabled = false;
    const plants = structuredClone(project.foliage);
    const terrain = new TerrainScene(project);
    terrain.rebuildFoliage();
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(64, 1, 64),
      new THREE.MeshStandardMaterial(),
    );
    ground.position.y = -1;
    ground.castShadow = ground.receiveShadow = true;
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(10, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(256, 256);
    Object.assign(sun.shadow.camera, {
      left: -40,
      right: 40,
      top: 40,
      bottom: -40,
      far: 100,
    });
    const scene = new THREE.Scene();
    scene.add(ground, sun, terrain.foliage);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    camera.position.set(20, 20, 30);
    camera.lookAt(0, 0, 0);
    const renderer = await createTerrainRenderer();
    renderer.setSize(128, 128);
    renderer.shadowMap.enabled = true;
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (event) =>
      validation.push(event.error.message),
    );
    for (let cycle = 0; cycle < 3; cycle++) {
      renderer.render(scene, camera);
      project.foliage = [];
      terrain.rebuildFoliage();
      // Draw both within the disposal task and after deferred override cleanup.
      renderer.render(scene, camera);
      await Promise.resolve();
      renderer.render(scene, camera);
      project.foliage = structuredClone(plants);
      terrain.rebuildFoliage();
    }
    renderer.render(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    terrain.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
    sun.shadow.dispose();
    await Promise.resolve();
    await renderer.dispose();
    return { validation, allocatedBytes: renderer.info.memory.total };
  });
  expect(result.validation).toEqual([]);
  expect(result.allocatedBytes).toBe(0);
});
