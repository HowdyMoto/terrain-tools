import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('shore foam resolves fine detail, stays stable when paused and follows lighting', async ({
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
      environmentPreset,
    } = await import('/__runtime_test/lib/core.js');
    const p = createProject(32, 32);
    p.view.water = false;
    p.view.textureResolution = 256;
    p.foliage = [];
    for (const m of p.materials)
      Object.assign(m, {
        color: '#bfb193',
        roughness: 0.95,
        proceduralVariant: 2,
        normalStrength: 0.2,
      });
    for (let z = 0; z <= 32; z++)
      for (let x = 0; x <= 32; x++) p.heights[z * 33 + x] = (x - 16) * 0.18;
    p.water = defaultWaterSettings(p);
    p.water.seaLevel = 0;
    p.water.ocean.enabled = true;
    p.water.reflections = false;
    const surface = (p.water.ocean.surface = waterPreset('tropical'));
    Object.assign(surface, {
      foam: 1,
      foamWidth: 1.5,
      speed: 0,
      swellHeight: 0,
      waveHeight: 0,
      ripple: 0,
      wetness: 0,
      caustics: 0,
    });
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(1280, 720);
    document.body.style.margin = '0';
    document.body.replaceChildren(renderer.domElement);
    const scene = new THREE.Scene(),
      terrain = new TerrainScene(p);
    await terrain.load(p);
    scene.add(terrain);
    const environment = new TerrainEnvironment(scene, renderer);
    const settings = {
      ...environmentPreset('daylight'),
      fogEnabled: false,
      shadows: false,
      temporalAA: false,
      sunIntensity: 3,
      environmentIntensity: 0.5,
    };
    environment.set(settings, p);
    const camera = new THREE.OrthographicCamera(
      -3,
      3,
      1.6875,
      -1.6875,
      0.1,
      100,
    );
    camera.position.set(-0.5, 10, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(-0.5, 0, 0);
    camera.updateMatrixWorld();
    const target = new THREE.WebGLRenderTarget(1280, 720);
    const render = (dt = 0) => {
      terrain.update(dt, [], camera);
      renderer.setRenderTarget(target);
      environment.render(camera);
      const bytes = new Uint8Array(1280 * 720 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 1280, 720, bytes);
      renderer.setRenderTarget(null);
      environment.render(camera);
      return bytes;
    };
    const images = {};
    const shot = (name) => {
      images[name] = renderer.domElement.toDataURL();
    };
    const foam = render();
    shot('foam-close');
    surface.foam = 0;
    terrain.waterSystem.updateSettings(p);
    const plain = render();
    shot('foam-off');
    surface.foam = 1;
    terrain.waterSystem.updateSettings(p);
    const paused = render(0.1);
    const difference = (a, b, x0 = 460, x1 = 730) => {
      let sum = 0,
        n = 0;
      for (let y = 100; y < 620; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * 1280 + x) * 4;
          for (let c = 0; c < 3; c++) {
            sum += Math.abs(a[i + c] - b[i + c]);
            n++;
          }
        }
      return sum / n;
    };
    // Isolate foam from seabed texture, and measure detail along the shore
    // at a two-pixel (~9 mm) separation in this six-metre view.
    const detail = (a, b) => {
      let sum = 0,
        count = 0;
      for (let y = 100; y < 618; y++)
        for (let x = 470; x < 720; x++) {
          const i = (y * 1280 + x) * 4,
            j = ((y + 2) * 1280 + x) * 4;
          sum += Math.abs(a[i] - b[i] - (a[j] - b[j]));
          count++;
        }
      return sum / count;
    };
    const coarse = createProject(8, 32);
    coarse.materials = p.materials;
    coarse.water = p.water;
    for (let z = 0; z <= 8; z++)
      for (let x = 0; x <= 8; x++)
        coarse.heights[z * 9 + x] = (x * 4 - 16) * 0.18;
    terrain.waterSystem.apply(terrain.waterSystem.prepare(coarse));
    const coarseFoam = render();
    shot('foam-coarse-grid');
    terrain.waterSystem.apply(terrain.waterSystem.prepare(p));
    environment.set({ ...settings, temporalAA: true }, p);
    for (let i = 0; i < 12; i++) render();
    const temporalFoam = render();
    shot('foam-temporal');
    surface.foam = 0;
    terrain.waterSystem.updateSettings(p);
    for (let i = 0; i < 12; i++) render();
    const temporalPlain = render();
    surface.foam = 1;
    terrain.waterSystem.updateSettings(p);
    environment.set(settings, p);
    surface.speed = 1;
    for (let i = 0; i < 15; i++) render(0.1);
    const animated = render();
    shot('foam-animated');
    surface.speed = 0;
    environment.set(
      {
        ...settings,
        sunIntensity: 0,
        ambientIntensity: 0,
        environmentIntensity: 0,
      },
      p,
    );
    const darkFoam = render();
    surface.foam = 0;
    terrain.waterSystem.updateSettings(p);
    const darkPlain = render();
    surface.foam = 1;
    terrain.waterSystem.updateSettings(p);
    environment.set(settings, p);
    const low = new THREE.PerspectiveCamera(52, 1280 / 720, 0.05, 100);
    low.position.set(-4, 1.6, 4);
    low.lookAt(0, 0, -1);
    low.updateMatrixWorld();
    terrain.update(0, [], low);
    environment.render(low);
    shot('foam-oblique');
    const gl = renderer.getContext(),
      ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      images,
      adapter: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '',
      detail: detail(foam, plain),
      coarseGridDifference: difference(foam, coarseFoam),
      temporalDetail: detail(temporalFoam, temporalPlain),
      foamDifference: difference(foam, plain),
      outsideBandDifference: difference(foam, plain, 30, 200),
      pausedDifference: difference(foam, paused),
      animationDifference: difference(foam, animated),
      unlitFoamDifference: difference(darkFoam, darkPlain),
      error: environment.animationError ?? null,
    };
  });
  for (const [name, image] of Object.entries(result.images))
    await writeFile(
      info.outputPath(name + '.png'),
      Buffer.from(image.split(',')[1], 'base64'),
    );
  delete result.images;
  await writeFile(
    info.outputPath('foam-metrics.json'),
    JSON.stringify(result, null, 2),
  );
  expect(result.foamDifference).toBeGreaterThan(1);
  // The former broad noise measured <1 here. Fine foam must survive both
  // a four-metre terrain grid and the production temporal resolve.
  expect(result.detail).toBeGreaterThan(3);
  expect(result.coarseGridDifference).toBeLessThan(0.15);
  expect(result.temporalDetail).toBeGreaterThan(result.detail * 0.55);
  expect(result.outsideBandDifference).toBeLessThan(0.1);
  expect(result.pausedDifference).toBeLessThan(0.1);
  expect(result.animationDifference).toBeGreaterThan(0.2);
  expect(result.unlitFoamDifference).toBeLessThan(0.1);
  expect(result.error).toBeNull();
  expect(errors).toEqual([]);
});
