import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { foliageMotionScene } from '../../scripts/foliage-motion-scene.mjs';

test('native foliage velocity follows wind and contact, freezes when paused and rejects fresh coverage', async ({
  page,
}, info) => {
  await runtimePackagePage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { mrt, output, velocity, vec4, Fn, float } =
      await import('three/tsl');
    const { createProject, editFoliageModels } =
      await import('/__runtime_test/lib/core.js');
    const { TerrainScene, createTerrainRenderer, rendererDescription } =
      await import('/__runtime_test/lib/runtime.js');
    const project = createProject(8, 32);
    project.heights.fill(0);
    project.foliage = [];
    Object.assign(project.wind, {
      enabled: true,
      strength: 2,
      speed: 1,
      gust: 0,
      direction: 0,
    });
    const model = editFoliageModels(project.brushes[0], [])[0];
    Object.assign(model, {
      model: 'grass',
      wind: 1,
      alignToNormal: false,
      flexibility: { source: 'height', start: 0, end: 1, exponent: 1 },
      lods: [{ model: 'grass', distance: 30, density: 1 }],
      lodFadeDuration: 0.3,
    });
    project.foliage.push({
      id: 1,
      brushId: project.brushes[0].id,
      modelId: model.id,
      x: 0,
      z: 0,
      scale: 1,
      rotation: 0,
    });
    const terrain = new TerrainScene(project);
    // A horizontal leaf at y=2 plus an unused root vertex gives every drawn
    // vertex the same, analytically known wind translation. Alpha stays cutout.
    const leaf = new THREE.PlaneGeometry(1.5, 1.5)
      .rotateX(-Math.PI / 2)
      .translate(0, 2, 0);
    for (const name of ['position', 'normal', 'uv']) {
      const old = leaf.getAttribute(name);
      const data = new Float32Array(old.array.length + old.itemSize);
      data.set(old.array);
      if (name === 'normal') data[old.array.length + 1] = 1;
      leaf.setAttribute(name, new THREE.BufferAttribute(data, old.itemSize));
    }
    const count = leaf.getAttribute('position').count;
    const tangents = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) tangents.set([1, 0, 0, 1], i * 4);
    leaf.setAttribute('tangent', new THREE.BufferAttribute(tangents, 4));
    leaf.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3),
    );
    const mask = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        mask.set(
          [
            100,
            180,
            60,
            ((x - 7.5) / 7) ** 2 + ((y - 7.5) / 7) ** 2 < 1 ? 255 : 0,
          ],
          (y * 16 + x) * 4,
        );
    const texture = new THREE.DataTexture(mask, 16, 16);
    texture.needsUpdate = true;
    const source = new THREE.MeshStandardMaterial({
      map: texture,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    const parts = terrain.library.get('grass');
    parts.forEach((part) => {
      part.geometry.dispose();
      part.material.dispose();
    });
    parts.splice(0, parts.length, {
      geometry: leaf,
      material: source,
      matrix: new THREE.Matrix4(),
    });
    terrain.rebuildFoliage();
    const scene = new THREE.Scene();
    scene.add(
      terrain.foliage,
      new THREE.HemisphereLight(0xffffff, 0xffffff, 3),
    );
    const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 30);
    camera.position.set(0, 10, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const renderer = await createTerrainRenderer();
    renderer.setSize(512, 384);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const target = new THREE.RenderTarget(512, 384, {
      type: THREE.HalfFloatType,
      count: 2,
    });
    target.textures[0].name = 'output';
    target.textures[1].name = 'velocity';
    const confidence = Fn(
      (builder) => builder.material.terrainHistoryNode ?? float(1),
    )();
    const outputs = mrt({ output, velocity: vec4(velocity, 0, confidence) });
    const samples = [];
    const draw = async (dt, configure) => {
      await new Promise(requestAnimationFrame);
      if (dt > 0) terrain.foliage.update(dt);
      configure?.();
      renderer.setRenderTarget(target);
      renderer.setMRT(outputs);
      renderer.render(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        512,
        384,
        0,
      );
      const vectors = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        512,
        384,
        1,
      );
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
      let vx = 0,
        vy = 0,
        alpha = 0,
        coverage = 0,
        count = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (THREE.DataUtils.fromHalfFloat(pixels[i + 1]) > 0.1) {
          vx += THREE.DataUtils.fromHalfFloat(vectors[i]);
          vy += THREE.DataUtils.fromHalfFloat(vectors[i + 1]);
          alpha += THREE.DataUtils.fromHalfFloat(vectors[i + 3]);
          coverage += THREE.DataUtils.fromHalfFloat(pixels[i + 3]);
          count++;
        }
      const sample = {
        vx: vx / count,
        vy: vy / count,
        alpha: alpha / count,
        coverage: coverage / count,
        count,
      };
      samples.push(sample);
      return sample;
    };
    const initial = await draw(0);
    await draw(0.2);
    const moving = await draw(0.2);
    const paused = await draw(0);
    const mesh = terrain.foliage.children[0];
    const contact = mesh.geometry.getAttribute('terrainContact');
    const bent = await draw(0, () => {
      contact.setX(0, 0.5);
      contact.needsUpdate = true;
    });
    const bentPaused = await draw(0);
    mesh.visible = false;
    await draw(0);
    mesh.visible = true;
    const returned = await draw(0);
    await draw(0);
    const translated = await draw(0, () => {
      mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0.4, 0, 0));
      mesh.instanceMatrix.needsUpdate = true;
    });
    const translatedPaused = await draw(0);
    const amplitude = (t) => Math.sin(t * 1.7) * 0.5 * 2 * 0.09 * 2 ** 1.25;
    const expectedVx = (amplitude(0.4) - amplitude(0.2)) / 4;
    const adapter = rendererDescription(renderer);
    terrain.dispose();
    target.dispose();
    texture.dispose();
    await renderer.dispose();
    return {
      initial,
      moving,
      paused,
      bent,
      bentPaused,
      returned,
      translated,
      translatedPaused,
      expectedVx,
      samples,
      validation,
      adapter,
      allocatedBytes: renderer.info.memory.total,
    };
  });
  await writeFile(
    info.outputPath('foliage-motion.json'),
    JSON.stringify(result, null, 2),
  );
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  expect(result.initial.count).toBeGreaterThan(1000);
  expect(result.initial.alpha).toBe(0);
  expect(result.initial.coverage).toBe(1);
  expect(result.moving.alpha).toBe(1);
  expect(result.moving.vx).toBeCloseTo(result.expectedVx, 4);
  expect(Math.abs(result.moving.vy)).toBeLessThan(0.0001);
  for (const sample of [
    result.paused,
    result.bentPaused,
    result.translatedPaused,
  ]) {
    expect(Math.abs(sample.vx)).toBeLessThan(0.0001);
    expect(Math.abs(sample.vy)).toBeLessThan(0.0001);
  }
  expect(Math.abs(result.bent.vx)).toBeGreaterThan(0.02);
  expect(result.returned.alpha).toBe(0);
  // Translation also shifts the wind's spatial phase by a small amount.
  expect(result.translated.vx).toBeGreaterThan(0.09);
  expect(result.translated.vx).toBeLessThan(0.12);
  expect(result.allocatedBytes).toBe(0);
});

test('photoreal ferns retain stable motion history across water, shadows, LODs, pause, teleport and resize', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await runtimePackagePage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const fixture = await page.evaluate(foliageMotionScene, {
    width: 640,
    height: 360,
  });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const s = window.foliageMotionScene;
    const draw = async (dt = 1 / 30) => {
      await new Promise(requestAnimationFrame);
      s.step(dt, false);
      await s.renderer.backend.device.queue.onSubmittedWorkDone();
    };
    for (let i = 0; i < 12; i++) await draw();
    const velocity = async () => {
      const data = await s.renderer.readRenderTargetPixelsAsync(
        s.target,
        0,
        0,
        s.target.width,
        s.target.height,
        3,
      );
      const color = await s.renderer.readRenderTargetPixelsAsync(
        s.target,
        0,
        0,
        s.target.width,
        s.target.height,
        0,
      );
      let max = 0,
        sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        // Water has its own reactive history policy and geometric waves;
        // this regression measures opaque terrain and stable leaf coverage.
        if (THREE.DataUtils.fromHalfFloat(color[i + 3]) < 0.99) continue;
        const v = Math.hypot(
          THREE.DataUtils.fromHalfFloat(data[i]),
          THREE.DataUtils.fromHalfFloat(data[i + 1]),
        );
        max = Math.max(max, v);
        sum += v;
      }
      return {
        max,
        average: sum / (data.length / 4),
      };
    };
    const moving = await velocity();
    s.camera.position.x += 0.1;
    s.camera.lookAt(0, 0.7, -4);
    await draw(0);
    const cameraMoving = await velocity();
    await draw(0);
    await draw(0);
    const paused = await velocity();
    s.camera.position.z = 14;
    s.camera.lookAt(0, 0.7, -4);
    for (let i = 0; i < 18; i++) await draw();
    const lods = { ...s.terrain.foliage.viewStats };
    s.environment.invalidateHistory();
    s.camera.position.x = 4;
    s.camera.lookAt(0, 0.7, -4);
    await draw(0);
    await draw(0);
    const teleportedPaused = await velocity();
    s.renderer.setSize(512, 320);
    s.camera.aspect = 512 / 320;
    s.camera.updateProjectionMatrix();
    await draw(0);
    await draw(0);
    const resizedPaused = await velocity();
    const size = [s.target.width, s.target.height];
    return {
      moving,
      cameraMoving,
      paused,
      teleportedPaused,
      resizedPaused,
      lods,
      size,
      aspect: s.camera.aspect,
      errors: s.errors,
    };
  });
  await page.screenshot({ path: info.outputPath('moving-ferns.png') });
  const bytes = await page.evaluate(() => window.foliageMotionScene.dispose());
  await writeFile(
    info.outputPath('fern-motion.json'),
    JSON.stringify({ ...fixture, ...result, bytes }, null, 2),
  );
  expect(errors).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.moving.max).toBeGreaterThan(0.0001);
  expect(result.cameraMoving.max).toBeGreaterThan(0.001);
  expect(result.paused.max).toBeLessThan(0.0001);
  expect(result.teleportedPaused.max).toBeLessThan(0.0001);
  expect(result.resizedPaused.max).toBeLessThan(0.0001);
  expect(result.lods.levels[1]).toBeGreaterThan(0);
  expect(result.size).toEqual([512, 320]);
  expect(result.aspect).toBe(1.6);
  expect(bytes).toBe(0);
});
