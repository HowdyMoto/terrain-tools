import { test, expect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';

test('native terrain shares LOD shaders while preserving each tile palette and morph', async ({
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
    const { createProject } = await import('/__runtime_test/lib/core.js');
    const { TerrainScene, TerrainLod, WorldAssets, createTerrainRenderer } =
      await import('/__runtime_test/lib/runtime.js');
    const renderer = await createTerrainRenderer();
    const validation = [];
    renderer.backend.device.addEventListener('uncapturederror', (e) =>
      validation.push(e.error.message),
    );
    renderer.setSize(384, 192);
    document.body.replaceChildren(renderer.domElement);
    const assets = new WorldAssets();
    const a = createProject(32, 32);
    a.foliage = [];
    a.view.water = false;
    a.view.textureResolution = 256;
    a.heights.fill(0);
    for (let z = 0; z <= 32; z++)
      for (let x = 0; x <= 32; x++) a.heights[z * 33 + x] = x % 2 === 1 ? 4 : 0;
    a.materials.forEach((m) => {
      m.color = '#ff0808';
      m.normalStrength = 0;
    });
    const b = structuredClone(a);
    b.materials.forEach((m) => (m.color = '#0808ff'));
    const left = new TerrainScene(a, { assets }),
      right = new TerrainScene(b, { assets });
    await left.load();
    await right.load();
    const leftLod = new TerrainLod(left),
      rightLod = new TerrainLod(right);
    left.add(leftLod);
    right.add(rightLod);
    left.position.x = -18;
    right.position.x = 18;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0);
    scene.add(left, right, new THREE.HemisphereLight(0xffffff, 0x888888, 3));
    const camera = new THREE.OrthographicCamera(-38, 38, 19, -19, 0.1, 200);
    camera.position.set(0, 60, 45);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const target = new THREE.RenderTarget(384, 192);
    let builds = 0;
    renderer.debug.onNodeBuilderCreated = (b) => {
      if (b.object.geometry?.attributes.layerWeights) builds++;
    };
    const read = async () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const data = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        384,
        192,
      );
      renderer.setRenderTarget(null);
      return data;
    };
    const before = await read();
    const initialBuilds = builds;
    // Modify only one tile's morph. The other tile must keep its own uniform.
    leftLod.children.forEach((m) => (m.morphTargetInfluences[0] = 0.75));
    const morphed = await read();
    const morphBuilds = builds - initialBuilds;
    const region = (data, start, end) => {
      const sum = [0, 0, 0];
      let count = 0;
      for (let y = 50; y < 142; y++)
        for (let x = start; x < end; x++) {
          const i = (y * 384 + x) * 4;
          if (data[i] + data[i + 1] + data[i + 2] < 10) continue;
          for (let c = 0; c < 3; c++) sum[c] += data[i + c];
          count++;
        }
      return sum.map((v) => v / Math.max(1, count));
    };
    const changes = (first, second, start, end) => {
      let changed = 0;
      for (let y = 0; y < 192; y++)
        for (let x = start; x < end; x++) {
          const i = (y * 384 + x) * 4;
          if (
            Math.abs(first[i] - second[i]) +
              Math.abs(first[i + 1] - second[i + 1]) +
              Math.abs(first[i + 2] - second[i + 2]) >
            8
          )
            changed++;
        }
      return changed;
    };
    const legacy = new THREE.WebGLRenderer();
    legacy.setSize(384, 192);
    const legacyTarget = new THREE.WebGLRenderTarget(384, 192);
    legacy.setRenderTarget(legacyTarget);
    legacy.render(scene, camera);
    const reference = new Uint8Array(384 * 192 * 4);
    legacy.readRenderTargetPixels(legacyTarget, 0, 0, 384, 192, reference);
    // Compare occupied silhouettes, avoiding color/tone-mapping differences.
    // WebGPU and WebGL render-target readback have opposite vertical origins.
    const silhouette = (flip) => {
      let mismatch = 0;
      for (let y = 0; y < 192; y++)
        for (let x = 0; x < 384; x++) {
          const i = (y * 384 + x) * 4,
            j = ((flip ? 191 - y : y) * 384 + x) * 4;
          const native = morphed[i] + morphed[i + 1] + morphed[i + 2] > 10;
          const gl = reference[j] + reference[j + 1] + reference[j + 2] > 10;
          if (native !== gl) mismatch++;
        }
      return mismatch;
    };
    leftLod.dispose();
    left.dispose();
    const surviving = await read();
    renderer.render(scene, camera);
    const result = {
      initialBuilds,
      morphBuilds,
      left: region(before, 40, 150),
      right: region(before, 234, 344),
      leftChanges: changes(before, morphed, 0, 192),
      rightChanges: changes(before, morphed, 192, 384),
      silhouetteMismatch: Math.min(silhouette(false), silhouette(true)),
      survivingChanges: changes(morphed, surviving, 192, 384),
      validation,
    };
    legacyTarget.dispose();
    legacy.dispose();
    legacy.forceContextLoss();
    rightLod.dispose();
    right.dispose();
    assets.dispose();
    target.dispose();
    await renderer.dispose();
    return result;
  });
  await info.attach('terrain-batching', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  console.log('Terrain batching:', JSON.stringify(result));
  expect(errors).toEqual([]);
  expect(result.validation).toEqual([]);
  expect(result.initialBuilds).toBe(1);
  expect(result.morphBuilds).toBe(0);
  expect(result.left[0]).toBeGreaterThan(result.left[2] * 3);
  expect(result.right[2]).toBeGreaterThan(result.right[0] * 3);
  expect(result.leftChanges).toBeGreaterThan(100);
  expect(result.rightChanges).toBe(0);
  expect(result.silhouetteMismatch).toBeLessThan(100);
  expect(result.survivingChanges).toBe(0);
});
