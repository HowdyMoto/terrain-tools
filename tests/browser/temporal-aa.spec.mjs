import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('stabilizes subpixel foliage, rejects vanished geometry and restores camera and output state', async ({
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
    const { TerrainEnvironment } =
      await import('/__runtime_test/lib/runtime.js');
    const { createProject, defaultEnvironmentSettings } =
      await import('/__runtime_test/lib/core.js');
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(512, 256);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-4, 4, 2, -2, 0.1, 30);
    camera.position.z = 10;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const material = new THREE.MeshBasicMaterial({ color: '#74b545' });
    const fine = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.009, 3.4),
      material,
      280,
    );
    const transform = new THREE.Matrix4();
    for (let i = 0; i < 280; i++) {
      transform.makeTranslation(-3.8 + i * 0.027, Math.sin(i * 7) * 0.15, 0);
      fine.setMatrixAt(i, transform);
    }
    scene.add(fine);
    const solid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    solid.position.z = 1;
    scene.add(solid);
    const environment = new TerrainEnvironment(scene, renderer);
    const project = createProject(8, 20);
    const settings = {
      ...defaultEnvironmentSettings(),
      fogEnabled: false,
      shadows: false,
      backgroundColor: '#101810',
      exposure: 1,
      toneMapping: 'agx',
    };
    const target = new THREE.WebGLRenderTarget(512, 256, { samples: 4 });
    const projection = camera.projectionMatrix.clone();
    document.body.style.cssText =
      'margin:0;background:#151a1d;color:white;font:16px system-ui;display:flex;flex-wrap:wrap';
    const run = (temporalAA, temporalSharpness = 0.25) => {
      renderer.setRenderTarget(target);
      environment.set({ ...settings, temporalAA, temporalSharpness }, project);
      let previous,
        change = 0,
        center;
      for (let frame = 0; frame < 80; frame++) {
        camera.position.x = frame * 0.003;
        camera.updateMatrixWorld();
        renderer.setRenderTarget(target);
        environment.render(camera);
        const pixels = new Uint8Array(512 * 256 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 512, 256, pixels);
        if (frame > 30)
          for (let y = 30; y < 226; y++)
            for (let x = 20; x < 200; x++) {
              const index = (y * 512 + x) * 4 + 1;
              change += Math.abs(pixels[index] - previous[index]);
            }
        center = [
          ...pixels.subarray((128 * 512 + 256) * 4, (128 * 512 + 256) * 4 + 4),
        ];
        previous = pixels;
      }
      renderer.setRenderTarget(null);
      environment.render(camera);
      const figure = document.createElement('figure'),
        label = document.createElement('figcaption'),
        image = document.createElement('img');
      label.textContent = temporalAA
        ? 'Temporal + MSAA, detail ' + temporalSharpness
        : 'MSAA';
      image.src = renderer.domElement.toDataURL();
      figure.append(label, image);
      document.body.append(figure);
      let contrast = 0,
        minimum = 255,
        maximum = 0;
      for (let y = 30; y < 226; y++)
        for (let x = 20; x < 200; x++) {
          const i = (y * 512 + x) * 4 + 1;
          contrast += Math.abs(previous[i] - previous[i + 4]);
          minimum = Math.min(minimum, previous[i]);
          maximum = Math.max(maximum, previous[i]);
        }
      return { change, center, contrast, minimum, maximum };
    };
    const msaa = run(false),
      temporal = run(true);
    const soft = run(true, 0),
      detailed = run(true, 1);
    const projectionRestored = camera.projectionMatrix.equals(projection);
    fine.visible = solid.visible = false;
    renderer.setRenderTarget(target);
    environment.render(camera);
    const vanished = new Uint8Array(512 * 256 * 4);
    renderer.readRenderTargetPixels(target, 0, 0, 512, 256, vanished);
    environment.set({ ...settings, temporalAA: false }, project);
    environment.render(camera);
    const clean = new Uint8Array(512 * 256 * 4);
    renderer.readRenderTargetPixels(target, 0, 0, 512, 256, clean);
    let ghost = 0;
    for (let i = 0; i < clean.length; i++)
      ghost = Math.max(ghost, Math.abs(clean[i] - vanished[i]));
    const restored =
      renderer.getRenderTarget() === target &&
      renderer.toneMapping === THREE.AgXToneMapping &&
      renderer.outputColorSpace === THREE.SRGBColorSpace;
    environment.dispose();
    target.dispose();
    renderer.dispose();
    return {
      msaa,
      temporal,
      soft,
      detailed,
      ratio: temporal.change / msaa.change,
      ghost,
      projectionRestored,
      restored,
    };
  });
  await writeFile(
    info.outputPath('temporal-metrics.json'),
    JSON.stringify(result, null, 2),
  );
  expect(errors).toEqual([]);
  expect(result.ratio).toBeLessThan(0.9);
  expect(result.detailed.contrast).toBeGreaterThan(result.soft.contrast * 1.01);
  expect(result.detailed.minimum).toBeGreaterThanOrEqual(
    result.soft.minimum - 12,
  );
  expect(result.detailed.maximum).toBeLessThanOrEqual(result.soft.maximum + 12);
  expect(result.ghost).toBeLessThanOrEqual(1);
  expect(result.projectionRestored).toBe(true);
  expect(result.restored).toBe(true);
  for (let i = 0; i < 4; i++)
    expect(
      Math.abs(result.msaa.center[i] - result.temporal.center[i]),
    ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('temporal-edges.png'),
    fullPage: true,
  });
});
