import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('wet banks, shallow light, temporal water and legacy restoration render correctly', async ({
  page,
}, info) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /THREE|Shader|WebGL/.test(m.text()))
      errors.push(m.text());
  });
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { TerrainScene, TerrainEnvironment } =
      await import('/__runtime_test/lib/runtime.js');
    const {
      createProject,
      defaultWaterSettings,
      waterPreset,
      defaultEnvironmentSettings,
    } = await import('/__runtime_test/lib/core.js');
    const p = createProject(32, 32);
    p.view.water = false;
    p.view.textureResolution = 256;
    p.foliage = [];
    for (let z = 0; z <= 32; z++)
      for (let x = 0; x <= 32; x++) p.heights[z * 33 + x] = (x - 16) * 0.15;
    p.water = defaultWaterSettings(p);
    p.water.ocean.enabled = true;
    p.water.seaLevel = 0;
    p.water.ocean.surface = waterPreset('tropical');
    p.water.ocean.surface.wetness = 0;
    p.water.ocean.surface.caustics = 0;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(512, 512);
    document.body.replaceChildren(renderer.domElement);
    const scene = new THREE.Scene(),
      terrain = new TerrainScene(p);
    await terrain.load(p);
    scene.add(terrain);
    const environment = new TerrainEnvironment(scene, renderer);
    const settings = {
      ...defaultEnvironmentSettings(),
      fogEnabled: false,
      shadows: false,
      temporalAA: false,
      ambientOcclusion: { enabled: false, radius: 1, strength: 1 },
      sunIntensity: 3,
      ambientIntensity: 0.2,
      environmentIntensity: 0,
      showBackground: false,
      toneMapping: 'neutral',
    };
    environment.set(settings, p);
    const camera = new THREE.OrthographicCamera(-16, 16, 16, -16, 0.1, 100);
    camera.position.set(0, 40, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const target = new THREE.WebGLRenderTarget(512, 512);
    const render = (time = 0, water = false) => {
      terrain.update(time, [], camera);
      for (const mesh of terrain.waterSystem.surfaces) mesh.visible = water;
      renderer.setRenderTarget(target);
      environment.render(camera);
      const bytes = new Uint8Array(512 * 512 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 512, 512, bytes);
      renderer.setRenderTarget(null);
      environment.render(camera);
      return bytes;
    };
    const mean = (bytes, x0, x1) => {
      let sum = 0,
        n = 0;
      for (let y = 100; y < 400; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * 512 + x) * 4;
          sum += bytes[i] + bytes[i + 1] + bytes[i + 2];
          n += 3;
        }
      return sum / n;
    };
    const difference = (a, b, x0, x1) => {
      let sum = 0,
        n = 0;
      for (let y = 100; y < 400; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * 512 + x) * 4;
          for (let c = 0; c < 3; c++) {
            sum += Math.abs(a[i + c] - b[i + c]);
            n++;
          }
        }
      return sum / n;
    };
    const commit = () => {
      const prepared = terrain.waterSystem.prepare(p);
      terrain.waterSystem.prepareGPU(prepared, renderer, camera, scene);
      terrain.waterSystem.apply(prepared);
    };
    const dry = render();
    p.water.ocean.surface.wetness = 1;
    commit();
    const wet = render();
    p.water.ocean.surface.caustics = 1;
    commit();
    const lit = render();
    for (let i = 0; i < 20; i++) render(0.1);
    const animated = render(0.1);
    environment.set({ ...settings, sunIntensity: 0 }, p);
    const unlit = render();
    p.water.ocean.surface.caustics = 0;
    commit();
    const unlitPlain = render();
    environment.set({ ...settings, temporalAA: true }, p);
    p.water.ocean.surface.caustics = 1;
    commit();
    for (let i = 0; i < 12; i++) render(0.016, true);
    const temporal = render(0.016, true);
    const alpha = temporal[(256 * 512 + 128) * 4 + 3];
    const saved = p.water;
    delete p.water;
    await terrain.load(p);
    environment.set(settings, p);
    const legacy = render();
    p.water = saved;
    const gl = renderer.getContext(),
      ext = gl.getExtension('WEBGL_debug_renderer_info');
    const adapter = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    const result = {
      adapter,
      dry: mean(dry, 120, 200),
      wet: mean(wet, 120, 200),
      bankDry: mean(dry, 260, 285),
      bankWet: mean(wet, 260, 285),
      dryLandDifference: difference(dry, wet, 380, 440),
      causticDifference: difference(wet, lit, 120, 200),
      animationDifference: difference(lit, animated, 120, 200),
      indirectCausticDifference: difference(unlit, unlitPlain, 120, 200),
      legacyDifference: difference(dry, legacy, 80, 440),
      alpha,
      error: environment.animationError ?? null,
    };
    // Leave the illustrated water view for the test screenshot.
    await terrain.load(p);
    environment.set({ ...settings, temporalAA: true }, p);
    for (let i = 0; i < 12; i++) render(0.016, true);
    return result;
  });
  await page.screenshot({ path: info.outputPath('shallow-water.png') });
  await info.attach('water-lighting.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  await writeFile(
    info.outputPath('water-lighting.json'),
    JSON.stringify(result, null, 2),
  );
  expect(result.wet).toBeLessThan(result.dry * 0.9);
  expect(result.bankWet).toBeLessThan(result.bankDry * 0.98);
  expect(result.dryLandDifference).toBeLessThan(0.1);
  expect(result.causticDifference).toBeGreaterThan(0.2);
  expect(result.animationDifference).toBeGreaterThan(0.2);
  expect(result.indirectCausticDifference).toBeLessThan(0.1);
  expect(result.legacyDifference).toBeLessThan(0.1);
  expect(result.alpha).toBe(255);
  expect(result.error).toBeNull();
  expect(errors).toEqual([]);
});
