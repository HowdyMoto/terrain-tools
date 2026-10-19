import { test, expect as baseExpect } from '@playwright/test';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { inspectorControl } from './inspector-controls.mjs';
import { createProject, serializeProject } from 'terrain-tools';
// CI uses software rendering. Assert persistent readiness with bounded waits;
// its speed is independent of the dedicated-GPU quality/performance reports.
const expect = baseExpect.configure({ timeout: 45000 });
test.use({ viewport: { width: 960, height: 640 } });
test('prepared models and texture arrays preserve geometry, leaf coverage and linear maps', async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await runtimePackagePage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const {
      createModelDecoder,
      WorldAssets,
      RuntimeMaterialLibrary,
      modelMemory,
    } = await import('/__runtime_test/lib/runtime.js');
    const renderer = new THREE.WebGLRenderer({
      powerPreference: 'high-performance',
    });
    renderer.setSize(512, 512);
    document.body.append(renderer.domElement);
    const decoder = createModelDecoder(renderer),
      pool = new WorldAssets(undefined, decoder.decode);
    const manifest = await fetch('/runtime-assets/manifest.json').then((r) =>
      r.json(),
    );
    const library = new RuntimeMaterialLibrary(
      renderer,
      manifest.materials,
      new URL('/runtime-assets/', location.href).href,
    );
    const surfaces = await library.prepare(
      pool,
      library.palette([0, 1, 2, 3]),
      512,
    );
    const second = await library.prepare(
      pool,
      library.palette([4, 5, 6, 7]),
      512,
    );
    const shared = surfaces.lease.value[0] === second.lease.value[0];
    second.lease.release();
    const scene = new THREE.Scene(),
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
    camera.position.z = 1;
    const target = new THREE.WebGLRenderTarget(512, 512),
      geometry = new THREE.PlaneGeometry(2, 2);
    function read(texture, array = false, size = 512) {
      target.setSize(size, size);
      const material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { map: { value: texture }, side: { value: size } },
        vertexShader:
          'in vec3 position;void main(){gl_Position=vec4(position,1.0);}',
        fragmentShader: `precision highp float;precision highp ${array ? 'sampler2DArray' : 'sampler2D'};uniform ${array ? 'sampler2DArray' : 'sampler2D'} map;uniform float side;out vec4 color;void main(){color=textureLod(map,${array ? 'vec3(gl_FragCoord.xy/side,0.0)' : 'gl_FragCoord.xy/side'},0.0);}`,
      });
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      scene.remove(mesh);
      material.dispose();
      return pixels;
    }
    function compare(a, b) {
      let squared = 0,
        max = 0,
        coverage = 0;
      for (let i = 0; i < a.length; i++) {
        const e = Math.abs(a[i] - b[i]);
        squared += e * e;
        max = Math.max(max, e);
        if (i % 4 === 3 && a[i] >= 128 !== b[i] >= 128) coverage++;
      }
      return {
        psnr: squared ? 10 * Math.log10(255 ** 2 / (squared / a.length)) : 100,
        max,
        alphaCoverageDifference: coverage / (a.length / 4),
      };
    }
    const channels = {};
    for (const [i, key] of ['albedo', 'normal', 'orm', 'height'].entries()) {
      const source = await new THREE.TextureLoader().loadAsync(
        '/runtime-assets/reference-' + key + '.png',
      );
      source.flipY = false;
      source.colorSpace =
        key === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      channels[key] = compare(
        read(source),
        read(surfaces.lease.value[i], true),
      );
      source.dispose();
    }
    async function model(url, signal) {
      const blob = await fetch(url).then((r) => r.blob());
      const data = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      return decoder.decode(data, signal);
    }
    const original = await model('/foliage/photoreal/ph-fern-a.glb'),
      prepared = await model('/runtime-assets/ph-fern-a.glb');
    function bounds(model) {
      const box = new THREE.Box3();
      for (const part of model.parts) {
        const g = part.geometry.clone();
        g.applyMatrix4(part.matrix);
        g.computeBoundingBox();
        box.union(g.boundingBox);
        g.dispose();
      }
      return [...box.min.toArray(), ...box.max.toArray()];
    }
    const a = bounds(original),
      b = bounds(prepared),
      boundsError = Math.max(...a.map((n, i) => Math.abs(n - b[i])));
    const leaves = [];
    for (const part of original.parts)
      for (const material of Array.isArray(part.material)
        ? part.material
        : [part.material]) {
        if (!material.alphaTest || !material.map) continue;
        const other = prepared.parts
          .flatMap((p) =>
            Array.isArray(p.material) ? p.material : [p.material],
          )
          .find((m) => m.name === material.name);
        if (!other?.map) throw new Error('Prepared leaf material missing.');
        leaves.push(compare(read(material.map), read(other.map)));
      }
    const bytes = {
      original: modelMemory(original.parts),
      prepared: modelMemory(prepared.parts),
      surfaces: pool.stats,
    };
    original.dispose();
    prepared.dispose();
    surfaces.lease.release();
    pool.dispose();
    library.dispose();
    decoder.dispose();
    geometry.dispose();
    target.dispose();
    renderer.dispose();
    return { shared, channels, leaves, boundsError, bytes };
  });
  await testInfo.attach('compression-quality.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  await mkdir('.qa', { recursive: true });
  await writeFile(
    '.qa/compression-quality.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  expect(errors).toEqual([]);
  expect(result.shared).toBe(true);
  expect(result.boundsError).toBeLessThan(0.002);
  for (const metrics of Object.values(result.channels))
    expect(metrics.psnr).toBeGreaterThan(35);
  expect(result.leaves.length).toBeGreaterThan(0);
  for (const metrics of result.leaves) {
    expect(metrics.psnr).toBeGreaterThan(30);
    expect(metrics.alphaCoverageDifference).toBeLessThan(0.01);
  }
  expect(result.bytes.prepared.gpuBytes).toBeLessThan(
    result.bytes.original.gpuBytes / 2,
  );
});
test('compressed model cancellation and failure preserve a live terrain and allow retry', async ({
  page,
}) => {
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { TerrainScene, createModelDecoder, exportTerrainGLB } =
      await import('/__runtime_test/lib/runtime.js');
    const { createProject } = await import('/__runtime_test/lib/core.js');
    const renderer = new THREE.WebGLRenderer(),
      decoder = createModelDecoder(renderer);
    const p = createProject(8, 32);
    p.view.water = false;
    const scene = new TerrainScene(p, { decoder: decoder.decode });
    await scene.load(p, false);
    const before = scene.terrain.children[0].geometry;
    const blob = await fetch('/runtime-assets/ph-fern-a.glb').then((r) =>
      r.blob(),
    );
    const data = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
    const candidate = structuredClone(p);
    candidate.assets = { plant: { name: 'Fern', data } };
    candidate.brushes[0].model = 'plant';
    candidate.nextId = 2;
    candidate.foliage = [
      {
        id: 1,
        brushId: candidate.brushes[0].id,
        x: 0,
        z: 0,
        scale: 1,
        rotation: 0,
      },
    ];
    const controller = new AbortController(),
      request = scene.load(candidate, false, controller.signal);
    queueMicrotask(() => controller.abort());
    const cancelled = !(await request),
      intactAfterCancel =
        scene.project === p && scene.terrain.children[0].geometry === before;
    const bad = structuredClone(candidate);
    bad.assets.plant.data = 'data:model/gltf-binary;base64,AAAA';
    let failed = false;
    try {
      await scene.load(bad, false);
    } catch {
      failed = true;
    }
    const intactAfterFailure =
      scene.project === p && scene.terrain.children[0].geometry === before;
    const retry = await scene.load(candidate, false);
    const compressed = scene.library
      .get('plant')
      .some((part) =>
        Object.values(part.material).some((t) => t?.isCompressedTexture),
      );
    const beforeExport = scene.library.get('plant')[0].material.map;
    const size = renderer.getSize(new THREE.Vector2()).toArray();
    const exported = await exportTerrainGLB(scene, { renderer });
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const presentation = await new GLTFLoader().parseAsync(exported, '');
    let exportedLeaf = false;
    presentation.scene.traverse((object) => {
      if (object.material?.map && object.material.alphaTest > 0)
        exportedLeaf =
          !object.material.map.isCompressedTexture &&
          object.material.map.image.width > 0;
    });
    const exportPreservedSource =
      beforeExport === scene.library.get('plant')[0].material.map &&
      renderer
        .getSize(new THREE.Vector2())
        .toArray()
        .every((v, i) => v === size[i]);
    scene.dispose();
    decoder.dispose();
    renderer.dispose();
    return {
      cancelled,
      intactAfterCancel,
      failed,
      intactAfterFailure,
      retry,
      compressed,
      exportedLeaf,
      exportPreservedSource,
    };
  });
  expect(result).toEqual({
    cancelled: true,
    intactAfterCancel: true,
    failed: true,
    intactAfterFailure: true,
    retry: true,
    compressed: true,
    exportedLeaf: true,
    exportPreservedSource: true,
  });
});
test('editor previews, imports and restores a GPU-compressed foliage GLB', async ({
  page,
}) => {
  test.setTimeout(process.env.CI ? 420000 : 180000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: process.env.CI ? 180000 : 60000,
  });
  const p = createProject(32, 64);
  p.name = 'Compressed import fixture';
  p.view.textureResolution = 256;
  p.view.water = false;
  await page.locator('#file-open').setInputFiles({
    name: 'compressed-import.terrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(p)),
  });
  await expect(page.locator('#project-name')).toHaveValue(p.name, {
    timeout: 60000,
  });
  await page.locator('[data-tab=foliage]').click();
  await (await inspectorControl(page, '#import-foliage')).click();
  await page
    .locator('#foliage-files')
    .setInputFiles('public/runtime-assets/ph-fern-a.glb');
  await expect(page.locator('.import-status')).toContainText('1 model ready', {
    timeout: process.env.CI ? 90000 : 30000,
  });
  await expect(page.locator('#foliage-preview canvas')).toBeVisible();
  await page.locator('#foliage-import-name').fill('Compressed fern');
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0);
  await expect(page.locator('#brush-name')).toHaveValue('Compressed fern');
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 90000,
  });
  await expect(page.locator('#redo')).toBeEnabled();
  await page.locator('#redo').click();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 90000,
  });
  await page
    .locator('#brush-select')
    .selectOption({ label: 'Compressed fern' });
  await expect(page.locator('#brush-name')).toHaveValue('Compressed fern');
  await expect(page.locator('#save-state')).toHaveText('Saved locally', {
    timeout: 15000,
  });
  await page.reload();
  await page.locator('[data-tab=foliage]').click();
  await page
    .locator('#brush-select')
    .selectOption({ label: 'Compressed fern' });
  await expect(page.locator('#brush-name')).toHaveValue('Compressed fern', {
    timeout: 30000,
  });
  expect(errors).toEqual([]);
});
