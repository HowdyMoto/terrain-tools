import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('contact shading darkens indirect light while preserving sunlight and restoring renderer state', async ({
  page,
}, info) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error' && /THREE|WebGL|Shader/i.test(e.text()))
      errors.push(e.text());
  });
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { TerrainEnvironment, TerrainScene } =
      await import('/__runtime_test/lib/runtime.js');
    const { createProject, defaultEnvironmentSettings } =
      await import('/__runtime_test/lib/core.js');
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(640, 480);
    renderer.shadowMap.enabled = true;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
    camera.position.set(6, 5, 8);
    camera.lookAt(0, 0, 0);
    const material = new THREE.MeshStandardMaterial({
      color: 0xaaaaaa,
      roughness: 1,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), material);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const box = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), material);
    box.position.y = 1.5;
    scene.add(box);
    const project = createProject(8, 30);
    const environment = new TerrainEnvironment(scene, renderer);
    const base = {
      ...defaultEnvironmentSettings(),
      sunIntensity: 0,
      ambientIntensity: 2,
      fogEnabled: false,
      shadows: false,
      exposure: 1,
    };
    const ao = { enabled: true, radius: 2, strength: 2 };
    const target = new THREE.WebGLRenderTarget(640, 480);
    const render = () => {
      renderer.setRenderTarget(target);
      environment.render(camera);
      const bytes = new Uint8Array(640 * 480 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 640, 480, bytes);
      return bytes;
    };
    const show = (label) => {
      renderer.setRenderTarget(null);
      environment.render(camera);
      const figure = document.createElement('figure'),
        title = document.createElement('figcaption'),
        image = document.createElement('img');
      title.textContent = label;
      image.src = renderer.domElement.toDataURL();
      figure.append(title, image);
      document.body.append(figure);
    };
    document.body.style.cssText =
      'margin:0;background:#151a1d;color:white;font:16px system-ui;display:flex;flex-wrap:wrap';
    environment.set(base, project);
    const off = render();
    show('Indirect light · unoccluded');
    environment.set({ ...base, ambientOcclusion: ao }, project);
    const on = render();
    show('Indirect light · contact shading');
    let darkened = 0,
      maxReduction = 0,
      brightened = 0;
    for (let i = 0; i < on.length; i += 4) {
      if (off[i] - on[i] > 8) darkened++;
      if (on[i] - off[i] > 1) brightened++;
      maxReduction = Math.max(maxReduction, off[i] - on[i]);
    }
    environment.set({ ...base, sunIntensity: 3, ambientIntensity: 0 }, project);
    const directOff = render();
    environment.set(
      { ...base, sunIntensity: 3, ambientIntensity: 0, ambientOcclusion: ao },
      project,
    );
    const directOn = render();
    let directDifference = 0;
    for (let i = 0; i < directOff.length; i++)
      directDifference = Math.max(
        directDifference,
        Math.abs(directOff[i] - directOn[i]),
      );
    const stateRestored =
      renderer.getRenderTarget() === target &&
      scene.background !== null &&
      scene.overrideMaterial === null &&
      floor.material === material &&
      renderer.shadowMap.autoUpdate;
    // The layered terrain replaces Three's AO chunk for packed material AO.
    // Screen contact shading must still compose with that custom shader.
    project.view.water = false;
    project.view.textureResolution = 256;
    project.heights.fill(0);
    const terrain = new TerrainScene(project);
    await terrain.load(project);
    floor.visible = false;
    scene.add(terrain);
    environment.set(base, project);
    const terrainOff = render();
    show('Layered terrain · unoccluded');
    environment.set({ ...base, ambientOcclusion: ao }, project);
    const terrainOn = render();
    show('Layered terrain · contact shading');
    let terrainDarkened = 0;
    const ray = new THREE.Raycaster();
    const point = new THREE.Vector2();
    const boxBounds = new THREE.Box3(
      new THREE.Vector3(-1.5, 0, -1.5),
      new THREE.Vector3(1.5, 3, 1.5),
    );
    // Exclude rays hitting the box: only the actual terrain may satisfy this check.
    for (let y = 0; y < 480; y++)
      for (let x = 0; x < 640; x++) {
        point.set(((x + 0.5) / 640) * 2 - 1, ((y + 0.5) / 480) * 2 - 1);
        ray.setFromCamera(point, camera);
        if (ray.ray.intersectsBox(boxBounds)) continue;
        const i = (y * 640 + x) * 4;
        if (terrainOff[i + 1] - terrainOn[i + 1] > 3) terrainDarkened++;
      }
    environment.dispose();
    terrain.dispose();
    const hooksRestored = !material
      .customProgramCacheKey()
      .includes('terrain-indirect-ao');
    target.dispose();
    renderer.dispose();
    return {
      darkened,
      maxReduction,
      brightened,
      directDifference,
      stateRestored,
      hooksRestored,
      terrainDarkened,
    };
  });
  expect(errors).toEqual([]);
  expect(result.darkened).toBeGreaterThan(300);
  expect(result.maxReduction).toBeGreaterThan(15);
  expect(result.brightened).toBe(0);
  expect(result.directDifference).toBe(0);
  expect(result.stateRestored).toBe(true);
  expect(result.hooksRestored).toBe(true);
  expect(result.terrainDarkened).toBeGreaterThan(100);
  await page.screenshot({
    path: info.outputPath('contact-shading.png'),
    fullPage: true,
  });
  await writeFile(
    info.outputPath('occlusion-metrics.json'),
    JSON.stringify(result, null, 2),
  );
});
