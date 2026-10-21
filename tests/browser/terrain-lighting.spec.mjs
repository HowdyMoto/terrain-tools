import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('native terrain keeps sunlight and signed view normals correct from ground to aerial views', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await runtimePackagePage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { createProject, environmentPreset } =
      await import('/__runtime_test/lib/core.js');
    const {
      TerrainScene,
      TerrainLod,
      TerrainEnvironment,
      createTerrainRenderer,
      rendererDescription,
    } = await import('/__runtime_test/lib/runtime.js');
    const renderer = await createTerrainRenderer();
    renderer.setSize(512, 384);
    document.body.replaceChildren(renderer.domElement);
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    const p = createProject(32, 128);
    p.heights.fill(0);
    p.foliage = [];
    p.props = [];
    p.view.water = false;
    p.view.textureResolution = 256;
    const image = (color) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, 16, 16);
      return canvas.toDataURL();
    };
    const textures = {
      albedo: image('#888888'),
      normal: image('rgb(128,128,255)'),
      orm: image('rgb(255,255,0)'),
      height: image('#808080'),
    };
    for (const layer of p.materials)
      Object.assign(layer, {
        textures,
        color: '#ffffff',
        roughness: 1,
        metalness: 0,
        normalStrength: 0,
        blendHeight: 0,
      });
    const terrain = new TerrainScene(p);
    await terrain.load();
    const lod = new TerrainLod(terrain, {
      pixelError: 2,
      transitionSeconds: 0,
    });
    terrain.add(lod);
    const scene = new THREE.Scene();
    scene.add(terrain);
    const camera = new THREE.PerspectiveCamera(50, 512 / 384, 0.1, 1000);
    const environment = new TerrainEnvironment(scene, renderer);
    const settings = environmentPreset('natural');
    Object.assign(settings, {
      sunIntensity: 3,
      sunElevation: 55,
      sunAzimuth: 35,
      ambientIntensity: 0,
      environmentIntensity: 0,
      shadows: false,
      temporalAA: false,
      temporalSharpness: 0,
      fogEnabled: false,
    });
    settings.timeOfDay.enabled = false;
    settings.ambientOcclusion.enabled = true;
    await environment.load(settings, p);
    const draw = async () => {
      camera.updateMatrixWorld();
      terrain.update(0, [], camera);
      lod.update(camera, 384, 0);
      environment.updateCamera(camera);
      environment.render(camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
    };
    const read = async (target, index = 0) => {
      // Read aligned rows: native readback retains WebGPU's 256-byte row padding.
      const pixels = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        188,
        512,
        8,
        index,
      );
      const components =
        target.textures[index].format === THREE.RedFormat ? 1 : 4;
      const values = [];
      for (let y = 0; y < 8; y++)
        for (let x = 252; x < 260; x++)
          for (let c = 0; c < components; c++) {
            const value = pixels[(y * 512 + x) * components + c];
            values.push(
              pixels instanceof Uint16Array
                ? THREE.DataUtils.fromHalfFloat(value)
                : pixels instanceof Float32Array
                  ? value
                  : value / 255,
            );
          }
      return values;
    };
    const samples = [];
    for (const temporal of [false, true]) {
      settings.temporalAA = temporal;
      environment.set(settings, p);
      for (const profile of ['full', 'lod', 'transformed-lod']) {
        terrain.rotation.set(
          profile === 'transformed-lod' ? 0.12 : 0,
          0,
          profile === 'transformed-lod' ? 0.2 : 0,
        );
        terrain.scale.set(1.2, 0.7, 1.1);
        for (const height of [15, 60, 240]) {
          camera.position.set(0, height, 40);
          camera.up.set(0, 1, 0);
          camera.lookAt(0, 0, 0);
          camera.rotateZ(-Math.PI / 6);
          environment.invalidateHistory();
          for (let i = 0; i < 4; i++) {
            await draw();
            lod.visible = profile !== 'full';
            terrain.terrain.visible = profile === 'full';
          }
          const pipeline = environment.gpuPipeline;
          const normals = await read(pipeline.water.target, 1);
          const color = await read(pipeline.water.target);
          const ao = await read(pipeline.occlusion._aoRenderTarget);
          const expected = new THREE.Vector3(0, 1, 0)
            .applyNormalMatrix(
              new THREE.Matrix3().getNormalMatrix(terrain.matrixWorld),
            )
            .transformDirection(camera.matrixWorldInverse);
          let normalError = 0,
            luminance = 0;
          for (let i = 0; i < normals.length; i += 4) {
            normalError = Math.max(
              normalError,
              Math.abs(normals[i] - expected.x),
              Math.abs(normals[i + 1] - expected.y),
              Math.abs(normals[i + 2] - expected.z),
            );
            luminance +=
              color[i] * 0.2126 + color[i + 1] * 0.7152 + color[i + 2] * 0.0722;
          }
          samples.push({
            temporal,
            profile,
            height,
            normalError,
            luminance: luminance / (color.length / 4),
            ao: ao.reduce((s, n) => s + n, 0) / ao.length,
            expected: expected.toArray(),
          });
        }
      }
    }
    // Correct normals must not remove real contact occlusion.
    terrain.rotation.set(0, 0, 0);
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(6, 6, 6),
      new THREE.MeshStandardMaterial(),
    );
    box.position.y = 3;
    scene.add(box);
    camera.position.set(12, 16, 24);
    camera.lookAt(0, 0, 0);
    for (let i = 0; i < 4; i++) await draw();
    const aoTarget = environment.gpuPipeline.occlusion._aoRenderTarget;
    const aoPixels = await renderer.readRenderTargetPixelsAsync(
      aoTarget,
      0,
      0,
      512,
      384,
    );
    const contactOcclusion = aoPixels.reduce(
      (lowest, value) => Math.min(lowest, value),
      255,
    );
    const adapter = rendererDescription(renderer);
    box.geometry.dispose();
    box.material.dispose();
    lod.dispose();
    terrain.dispose();
    environment.dispose();
    renderer.dispose();
    return { samples, contactOcclusion, validation, adapter };
  });
  await info.attach('terrain-lighting.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  await writeFile(
    info.outputPath('terrain-lighting.json'),
    JSON.stringify(result, null, 2),
  );
  console.log('Terrain view lighting:', {
    probes: result.samples.length,
    maxNormalError: Math.max(...result.samples.map((s) => s.normalError)),
    minFlatAO: Math.min(...result.samples.map((s) => s.ao)),
    contactOcclusion: result.contactOcclusion,
    validation: result.validation,
  });
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  for (const sample of result.samples) {
    expect(sample.normalError).toBeLessThan(0.002);
    expect(sample.ao).toBeGreaterThan(0.95);
    expect(sample.luminance).toBeGreaterThan(0.05);
  }
  for (const temporal of [false, true])
    for (const profile of ['full', 'lod', 'transformed-lod']) {
      const values = result.samples
        .filter((s) => s.temporal === temporal && s.profile === profile)
        .map((s) => s.luminance);
      expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.08);
    }
  expect(result.contactOcclusion).toBeLessThan(230);
});
