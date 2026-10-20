import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('native canopy field shades indirect light, follows terrain transforms and stays out of GLB exports', async ({
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
      parseProjectFile,
    } = await import('/__runtime_test/lib/core.js');
    const {
      TerrainScene,
      TerrainEnvironment,
      createTerrainRenderer,
      exportTerrainGLB,
    } = await import('/__runtime_test/lib/runtime.js');
    const renderer = await createTerrainRenderer();
    renderer.setSize(512, 384);
    document.body.replaceChildren(renderer.domElement);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const p = createProject(16, 24);
    p.heights.fill(0);
    p.foliage = [];
    p.view.water = false;
    p.view.textureResolution = 256;
    p.environment = environmentPreset('natural');
    p.environment.timeOfDay.enabled = false;
    Object.assign(p.environment, {
      temporalAA: false,
      shadows: false,
      ambientOcclusion: { enabled: false, radius: 2.5, strength: 1.25 },
      fogEnabled: false,
      sunIntensity: 0,
      ambientIntensity: 2,
    });
    const model = editFoliageModels(p.brushes[0], [])[0];
    model.model = 'pine';
    for (let z = -6; z <= 6; z += 3)
      for (let x = -6; x <= 6; x += 3)
        p.foliage.push({
          id: p.nextId++,
          brushId: p.brushes[0].id,
          modelId: model.id,
          x,
          z,
          scale: 2,
          rotation: x,
        });
    const terrain = new TerrainScene(p);
    await terrain.load();
    const scene = new THREE.Scene();
    scene.add(terrain);
    const environment = new TerrainEnvironment(scene, renderer);
    await environment.load(p.environment, p);
    const camera = new THREE.PerspectiveCamera(55, 512 / 384, 0.1, 200);
    camera.position.set(0, 3, 10);
    camera.lookAt(0, 0, 0);
    // Hide the crowns for this controlled light test: the baked cover must still
    // affect visible ground when occluders are outside the rendered view.
    terrain.foliage.visible = false;
    const target = new THREE.RenderTarget(512, 384);
    const image = async () => {
      await new Promise(requestAnimationFrame);
      terrain.update(0, [], camera);
      environment.updateCamera(camera);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      return new Uint8Array(
        await renderer.readRenderTargetPixelsAsync(target, 0, 0, 512, 384),
      );
    };
    const off = await image();
    p.environment.canopyLighting = { enabled: true, strength: 1, bounce: 0 };
    const prepared = await terrain.canopyLighting.prepare(p);
    await terrain.canopyLighting.prepareGPU(prepared, renderer);
    terrain.canopyLighting.apply(prepared);
    environment.set(p.environment, p);
    const on = await image();
    let darker = 0,
      lighter = 0;
    const sums = [off, on].map((a) => a.reduce((s, v) => s + v, 0));
    for (let i = 0; i < off.length; i += 4) {
      const delta =
        off[i] + off[i + 1] + off[i + 2] - on[i] - on[i + 1] - on[i + 2];
      if (delta > 3) darker++;
      if (delta < -3) lighter++;
    }
    // Scene objects outside TerrainScene must not inherit its last draw binding.
    terrain.visible = false;
    const foreignGeometry = new THREE.PlaneGeometry(24, 24),
      foreignMaterial = new THREE.MeshStandardMaterial({ color: '#899976' });
    const foreign = new THREE.Mesh(foreignGeometry, foreignMaterial);
    foreign.rotation.x = -Math.PI / 2;
    scene.add(foreign);
    p.environment.canopyLighting.enabled = false;
    environment.set(p.environment, p);
    const foreignOff = await image();
    p.environment.canopyLighting.enabled = true;
    environment.set(p.environment, p);
    const foreignOn = await image();
    let foreignError = 0;
    for (let i = 0; i < foreignOff.length; i++)
      foreignError += Math.abs(foreignOff[i] - foreignOn[i]);
    foreign.removeFromParent();
    foreignGeometry.dispose();
    foreignMaterial.dispose();
    terrain.visible = true;
    terrain.position.set(4, 0, 5);
    camera.position.add(new THREE.Vector3(4, 0, 5));
    camera.lookAt(4, 0, 5);
    const moved = await image();
    let movedError = 0;
    for (let i = 0; i < moved.length; i++)
      movedError += Math.abs(moved[i] - on[i]);
    // With indirect fill removed, canopy shade must leave direct sunlight alone.
    Object.assign(p.environment, {
      ambientIntensity: 0,
      environmentIntensity: 0,
      sunIntensity: 8,
    });
    p.environment.canopyLighting = { enabled: true, strength: 1, bounce: 0 };
    environment.set(p.environment, p);
    const directOn = await image();
    p.environment.canopyLighting.enabled = false;
    environment.set(p.environment, p);
    const directOff = await image();
    let directError = 0;
    for (let i = 0; i < directOn.length; i++)
      directError += Math.abs(directOn[i] - directOff[i]);
    const cubeGeometry = new THREE.BoxGeometry(2, 2, 2),
      cubeMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff' });
    const cube = new THREE.Mesh(cubeGeometry, cubeMaterial);
    cube.position.y = 1;
    terrain.add(cube);
    terrain.canopyLighting.bind();
    p.environment.canopyLighting = { enabled: true, strength: 0, bounce: 0 };
    environment.set(p.environment, p);
    const noBounce = await image();
    p.environment.canopyLighting.bounce = 1;
    environment.set(p.environment, p);
    const bounce = await image();
    let brighter = 0;
    let bounceDelta = 0;
    for (let i = 0; i < bounce.length; i += 4) {
      const d =
        bounce[i] +
        bounce[i + 1] +
        bounce[i + 2] -
        noBounce[i] -
        noBounce[i + 1] -
        noBounce[i + 2];
      bounceDelta = Math.max(bounceDelta, d);
      if (d > 0) brighter++;
    }
    p.environment.timeOfDay.enabled = true;
    p.environment.timeOfDay.hour = 0;
    environment.set(p.environment, p);
    // Settle the newly created atmospheric sky before comparing bounce.
    await image();
    const nightBounce = await image();
    p.environment.canopyLighting.bounce = 0;
    environment.set(p.environment, p);
    const nightOff = await image();
    let nightError = 0;
    for (let i = 0; i < nightOff.length; i++)
      nightError += Math.abs(nightOff[i] - nightBounce[i]);
    cube.removeFromParent();
    cubeGeometry.dispose();
    cubeMaterial.dispose();
    renderer.setRenderTarget(null);
    const glb = await exportTerrainGLB(terrain);
    const recovered = parseProjectFile(glb);
    const fields = {
      volume: terrain.canopyLighting.field.texture.image.data.byteLength,
      ground: terrain.canopyLighting.field.groundTexture.image.data.byteLength,
    };
    terrain.dispose();
    environment.dispose();
    target.dispose();
    await renderer.dispose();
    return {
      foreignError,
      bounceDelta,
      directError,
      brighter,
      nightError,
      sums,
      darker,
      lighter,
      movedError: movedError / moved.length,
      fields,
      recovered: recovered.environment.canopyLighting,
      validation,
      cleanup: renderer.info.memory.total,
    };
  });
  await info.attach('canopy-lighting', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  });
  console.log(JSON.stringify(result));
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  expect(result.darker).toBeGreaterThan(300);
  expect(result.lighter).toBe(0);
  expect(result.movedError).toBeLessThan(0.1);
  expect(result.foreignError).toBe(0);
  expect(result.directError).toBe(0);
  expect(result.nightError).toBe(0);
  expect(result.brighter).toBeGreaterThan(50);
  expect(result.fields).toEqual({ volume: 36864, ground: 1152 });
  expect(result.recovered.enabled).toBe(true);
  expect(result.cleanup).toBe(0);
});
