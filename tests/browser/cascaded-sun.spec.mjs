import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('cascades conserve sunlight, retain other lights and cast shadows across camera distances', async ({
  page,
}, info) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error' && /THREE|WebGL|Shader/i.test(e.text()))
      errors.push(e.text());
  });
  await runtimePackagePage(page);
  const metrics = await page.evaluate(async () => {
    const THREE = await import('three');
    const { TerrainEnvironment } =
      await import('/__runtime_test/lib/runtime.js');
    const { createProject, defaultEnvironmentSettings } =
      await import('/__runtime_test/lib/core.js');
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(960, 540);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.style.cssText =
      'margin:0;background:#151a1d;color:white;font:16px system-ui';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 960 / 540, 0.1, 300);
    camera.position.set(0, 5, 12);
    camera.lookAt(0, 0, -30);
    // Shadowed host light preceding our rig exercises directional-light indexing.
    const fill = new THREE.DirectionalLight(0x7799ff, 0.3);
    fill.castShadow = true;
    fill.position.set(-30, 20, -15);
    scene.add(fill, fill.target);
    const material = new THREE.MeshStandardMaterial({
      color: 0x999999,
      roughness: 1,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const environment = new TerrainEnvironment(scene, renderer);
    const project = createProject(8, 220);
    const base = {
      ...defaultEnvironmentSettings(),
      ambientIntensity: 0,
      sunIntensity: 2,
      sunColor: '#ffffff',
      sunAzimuth: 120,
      sunElevation: 38,
      shadowResolution: 1024,
      shadowNormalBias: 0.01,
      shadowBias: -0.00005,
      fogEnabled: false,
      exposure: 1,
    };
    const target = new THREE.WebGLRenderTarget(960, 540);
    const render = () => {
      environment.updateCamera(camera);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(960 * 540 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 960, 540, pixels);
      return pixels;
    };
    environment.set(base, project);
    const single = render();
    environment.set(
      { ...base, shadowCascades: 3, shadowDistance: 120 },
      project,
    );
    const cascade = render();
    let energyError = 0;
    for (let i = 0; i < single.length; i += 4)
      energyError = Math.max(energyError, Math.abs(single[i] - cascade[i]));
    for (let z = 4; z >= -90; z -= 8) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.35, 3, 0.35),
        material,
      );
      box.position.set(0, 1.5, z);
      box.castShadow = box.receiveShadow = true;
      scene.add(box);
    }
    const shadowed = render();
    let shadowPixels = 0;
    for (let i = 0; i < single.length; i += 4)
      if (shadowed[i] < cascade[i] * 0.5 && cascade[i] > 30) shadowPixels++;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const img = document.createElement('img');
    img.src = renderer.domElement.toDataURL();
    document.body.append(img);
    environment.set({ ...base, shadows: false }, project);
    const disabled = render();
    environment.dispose();
    const restored = !material
      .customProgramCacheKey()
      .includes('terrain-cascades');
    target.dispose();
    renderer.dispose();
    return {
      energyError,
      shadowPixels,
      restored,
      disabledPixels: disabled.length,
    };
  });
  expect(errors).toEqual([]);
  expect(metrics.energyError).toBeLessThanOrEqual(1);
  expect(metrics.shadowPixels).toBeGreaterThan(2000);
  expect(metrics.restored).toBe(true);
  await page.screenshot({ path: info.outputPath('cascade-coverage.png') });
  await writeFile(
    info.outputPath('cascade-metrics.json'),
    JSON.stringify(metrics, null, 2),
  );
});
