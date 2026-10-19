import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProject,
  generateTerrain,
  serializeProject,
  parseMaterialPreset,
} from 'terrain-tools';
import { decodeDocument, solidPng, triangleGlb } from './fixtures.mjs';
import { runtimePackagePage } from './runtime-package-page.mjs';

const png = (r, g, b) =>
  'data:image/png;base64,' + solidPng(r, g, b).toString('base64');
async function download(page, button, path) {
  const pending = page.waitForEvent('download');
  await (await inspectorControl(page, button)).click();
  const file = await pending;
  await file.saveAs(path);
  return { bytes: await readFile(path), name: file.suggestedFilename() };
}
async function save(page, testInfo, name) {
  return decodeDocument(
    (await download(page, '#save', testInfo.outputPath(name + '.terrain')))
      .bytes,
  );
}
async function open(page, project) {
  await page.locator('#file-open').setInputFiles({
    name: 'surface-study.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
}
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /THREE|Shader|WebGL/i.test(message.text())
    )
      errors.push(message.text());
  });
  return errors;
}

test('reuses a mapped surface across projects with preserved identity, optional rules and transactional recovery', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    const read = File.prototype.text;
    File.prototype.text = function () {
      const result = read.call(this);
      if (this.name !== 'held.surface.json') return result;
      return new Promise((resolve, reject) => {
        window.releaseSurfaceRead = () => result.then(resolve, reject);
      });
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'src',
    );
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...descriptor,
      set(value) {
        if (window.holdSurfaceImage && value.startsWith('data:image/')) {
          window.releaseSurfaceImage = () => descriptor.set.call(this, value);
          return;
        }
        descriptor.set.call(this, value);
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const source = createProject(32, 64);
  source.view.textureResolution = 256;
  source.assets.unused = {
    name: 'not-in-preset.glb',
    data: 'data:model/gltf-binary;base64,' + triangleGlb().toString('base64'),
  };
  Object.assign(source.materials[1], {
    name: 'Granite "warm" <face>',
    color: '#d8b49c',
    roughness: 0.67,
    metalness: 0.12,
    tileSize: 3.5,
    blendHeight: 0.6,
    normalStrength: 1.65,
    normalConvention: 'directx',
    minHeight: 12,
    maxHeight: 70,
    minSlope: 16,
    maxSlope: 74,
    feather: 2,
    textures: {
      albedo: png(180, 120, 60),
      normal: png(170, 70, 245),
      orm: png(210, 140, 30),
      height: png(120, 120, 120),
    },
  });
  await open(page, source);
  await page.locator('[data-tab="materials"]').click();
  await page.locator('[data-material="1"]').click();
  const exported = await download(
    page,
    '#save-surface-preset',
    testInfo.outputPath('granite.surface.json'),
  );
  expect(exported.name).toMatch(/\.surface\.json$/);
  const raw = JSON.parse(exported.bytes.toString()),
    preset = parseMaterialPreset(exported.bytes.toString());
  expect(Object.keys(raw)).toEqual(['kind', 'version', 'material']);
  expect(raw.material.id).toBeUndefined();
  expect(raw.material.proceduralVariant).toBe(1);
  expect(exported.bytes.toString()).not.toContain('not-in-preset');

  const target = createProject(32, 96, 17);
  generateTerrain(target, 'flat');
  target.name = 'Another landscape';
  target.view.textureResolution = 512;
  target.materials[0].id = 'target-ground';
  for (const brush of target.brushes)
    brush.materials = brush.materials.map((id) =>
      id === 'grass' ? 'target-ground' : id,
    );
  target.materials[0].textures = { height: png(222, 222, 222) };
  target.paint[0] = 1;
  target.holes[9] = 1;
  await open(page, target);
  await page.locator('[data-tab="materials"]').click();
  await page.locator('[data-material="0"]').click();
  const baseline = await save(page, testInfo, 'baseline');
  const historyBefore = await page.locator('#undo').getAttribute('title');
  const load = async (
    bytes = exported.bytes,
    name = 'granite.surface.json',
  ) => {
    await page
      .locator('#surface-preset-open')
      .setInputFiles({ name, mimeType: 'application/json', buffer: bytes });
  };
  await expect(page.locator('#surface-preset-rules')).not.toBeChecked();
  await load();
  await expect(page.locator('#toast')).toContainText('Surface preset loaded');
  await expect(page.locator('#mat-name')).toHaveValue(source.materials[1].name);
  const expected = structuredClone(baseline);
  const rules = Object.fromEntries(
    ['minHeight', 'maxHeight', 'minSlope', 'maxSlope', 'feather'].map((key) => [
      key,
      baseline.materials[0][key],
    ]),
  );
  expected.materials[0] = { ...preset.material, ...rules, id: 'target-ground' };
  expect(await save(page, testInfo, 'loaded')).toEqual(expected);
  const historyAfter = await page.locator('#undo').getAttribute('title');
  expect(Number(historyAfter.match(/(\d+) undo steps/)[1])).toBe(
    Number(historyBefore.match(/(\d+) undo steps/)[1]) + 1,
  );
  await page.locator('#undo').click();
  await expect(page.locator('#mat-name')).toHaveValue(
    baseline.materials[0].name,
  );
  expect(await save(page, testInfo, 'undo')).toEqual(baseline);
  await page.locator('#redo').click();
  await expect(page.locator('#mat-name')).toHaveValue(source.materials[1].name);
  expect(await save(page, testInfo, 'redo')).toEqual(expected);

  const bad = structuredClone(raw);
  bad.material.textures.normal = 'data:image/png;base64,YmFk';
  await load(Buffer.from(JSON.stringify(bad)));
  await expect(page.locator('#toast')).toContainText(
    'Could not load surface preset',
  );
  expect(await page.locator('#undo').getAttribute('title')).toBe(historyAfter);
  expect(await save(page, testInfo, 'failed-decode')).toEqual(expected);
  bad.material.normalConvention = 'bad';
  await load(Buffer.from(JSON.stringify(bad)));
  await expect(page.locator('#toast')).toContainText('normal map convention');
  expect(await page.locator('#undo').getAttribute('title')).toBe(historyAfter);

  const held = structuredClone(raw);
  held.material.textures.albedo = png(31, 72, 99);
  await page.evaluate(() => {
    window.holdSurfaceImage = true;
  });
  await load(Buffer.from(JSON.stringify(held)));
  await page.waitForFunction(() => !!window.releaseSurfaceImage);
  await page.locator('#cancel-preparation').click();
  await page.evaluate(() => {
    window.holdSurfaceImage = false;
    window.releaseSurfaceImage();
  });
  expect(await save(page, testInfo, 'cancelled')).toEqual(expected);
  expect(await page.locator('#undo').getAttribute('title')).toBe(historyAfter);

  // Selecting another destination while a file is being read cancels the original request.
  await load(exported.bytes, 'held.surface.json');
  await page.waitForFunction(() => !!window.releaseSurfaceRead);
  await page.locator('[data-material="2"]').click();
  await page.evaluate(() => window.releaseSurfaceRead());
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, testInfo, 'stale-read')).toEqual(expected);
  expect(await page.locator('#undo').getAttribute('title')).toBe(historyAfter);

  await page.locator('[data-material="0"]').click();
  await (await inspectorControl(page, '#surface-preset-rules')).check();
  await load();
  await expect(page.locator('#toast')).toContainText('Surface preset loaded');
  expected.materials[0] = { ...preset.material, id: 'target-ground' };
  expect(await save(page, testInfo, 'with-rules')).toEqual(expected);
  await expect(page.locator('#min-height')).toHaveValue('12');
  await expect(page.locator('#normal-convention')).toHaveValue('directx');
  await expect(page.locator('#texture-resolution')).toHaveValue('512');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await page.locator('[data-tab="materials"]').click();
  await page.locator('[data-material="0"]').click();
  expect(await save(page, testInfo, 'autosave')).toEqual(expected);
  const glb = await download(
    page,
    '#export',
    testInfo.outputPath('surface.glb'),
  );
  expect(decodeDocument(glb.bytes)).toEqual(expected);
  await (
    await inspectorControl(page, '#save-surface-preset')
  ).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('surface-presets.png') });
  expect(errors).toEqual([]);
});

test('procedural surface presets retain rendered appearance across slots and invalidate fallback caches', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const {
      createProject,
      serializeMaterialPreset,
      parseMaterialPreset,
      applyMaterialPreset,
    } = await import('/__runtime_test/lib/core.js');
    const { TerrainScene } = await import('/__runtime_test/lib/runtime.js');
    const project = createProject(32, 64);
    project.view.textureResolution = 256;
    const terrain = new TerrainScene(project),
      surface = terrain.terrainMaterial;
    await surface.update(project);
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(64, 64);
    const target = new THREE.WebGLRenderTarget(64, 64);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x454545, 2));
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(2, 5, 1);
    scene.add(sun);
    const geometry = new THREE.PlaneGeometry(12, 12);
    geometry.rotateX(-Math.PI / 2);
    const weights = new THREE.Float32BufferAttribute(new Float32Array(16), 4);
    geometry.setAttribute('layerWeights', weights);
    scene.add(new THREE.Mesh(geometry, surface.material));
    const camera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.1, 30);
    camera.position.set(0, 12, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    const render = (layer) => {
      weights.array.fill(0);
      for (let i = 0; i < 4; i++) weights.array[i * 4 + layer] = 1;
      weights.needsUpdate = true;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const bytes = new Uint8Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, bytes);
      return bytes;
    };
    const original = render(1);
    const preset = parseMaterialPreset(
      serializeMaterialPreset(project, project.materials[1].id),
    );
    project.materials[3] = applyMaterialPreset(project.materials[3], preset);
    await surface.update(project);
    const reused = render(3);
    const borrowed = await surface.prepare(project),
      first = borrowed.value.textures.value.arrays;
    project.materials[3].roughness = 0.4;
    await surface.update(project);
    const parameters = await surface.prepare(project);
    const parametersReuse = parameters.value.textures.value.arrays === first;
    parameters.dispose();
    project.materials[3].roughness = preset.material.roughness;
    project.materials[3].proceduralVariant = 2;
    await surface.update(project);
    const different = render(3),
      changed = await surface.prepare(project);
    const invalidated = changed.value.textures.value.arrays !== first;
    changed.dispose();
    borrowed.dispose();
    project.materials[3].proceduralVariant = 1;
    await surface.update(project);
    const restored = render(3);
    const difference = (a, b) =>
      a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0);
    const output = {
      same: difference(original, reused),
      restored: difference(original, restored),
      different: difference(original, different),
      parametersReuse,
      invalidated,
      range: Math.max(...original) - Math.min(...original),
    };
    geometry.dispose();
    target.dispose();
    terrain.dispose();
    renderer.dispose();
    return output;
  });
  expect(result.same).toBe(0);
  expect(result.restored).toBe(0);
  expect(result.different).toBeGreaterThan(1000);
  expect(result.range).toBeGreaterThan(30);
  expect(result.parametersReuse).toBe(true);
  expect(result.invalidated).toBe(true);
  expect(errors).toEqual([]);
});
