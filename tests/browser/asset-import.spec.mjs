import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  createProject,
  generateTerrain,
  serializeProject,
  decodeHeightmapPNG,
} from 'terrain-tools';
import { solidPng, triangleGlb, decodeDocument } from './fixtures.mjs';

async function setup(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /THREE|Shader|WebGL/i.test(message.text())
    )
      errors.push(message.text());
  });
  await page.addInitScript(() => {
    const Original = window.Uint8Array;
    window.Uint8Array = new Proxy(Original, {
      construct(target, args, constructor) {
        if (window.importFailHistory && args.length === 3 && args[2] === 4356)
          throw new RangeError('Injected import history failure');
        return Reflect.construct(target, args, constructor);
      },
    });
    const bitmap = window.createImageBitmap.bind(window);
    window.importBitmapReleases = [];
    window.createImageBitmap = (...args) => {
      if (window.importHoldBitmap)
        return new Promise((resolve, reject) => {
          window.importBitmapReleases.push(() =>
            bitmap(...args).then(resolve, reject),
          );
        });
      return bitmap(...args);
    };
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const project = createProject(32, 64);
  generateTerrain(project, 'flat');
  project.view.textureResolution = 256;
  project.view.water = false;
  await page.locator('#file-open').setInputFiles({
    name: 'import-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  return errors;
}
async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
const png = (name, rgb) => ({
  name,
  mimeType: 'image/png',
  buffer: solidPng(...rgb),
});

test('imports a complete PBR set with map review, numeric channel packing, retry, undo and persistence', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  const errors = await setup(page);
  await page.locator('[data-tab=materials]').click();
  const original = await save(page, info, 'material-before');
  await (await inspectorControl(page, '#import-material-set')).click();
  await page.locator('#material-files').setInputFiles([
    {
      name: 'Meadow_BaseColor.png',
      mimeType: 'image/png',
      buffer: await readFile('public/examples/upland/meadow-albedo.png'),
    },
    png('Meadow_NormalDX.png', [150, 100, 250]),
    {
      name: 'Meadow_AO.jpg',
      mimeType: 'image/jpeg',
      buffer: await sharp(solidPng(64, 64, 64))
        .jpeg({ quality: 100 })
        .toBuffer(),
    },
    png('Meadow_Gloss.png', [192, 192, 192]),
    png('Meadow_Metalness.png', [0, 128, 20]),
  ]);
  await expect(page.locator('[data-map-role="0"]')).toHaveValue('albedo');
  await expect(page.locator('#import-normal')).toHaveValue('directx');
  await expect(page.locator('#import-gloss')).toBeChecked();
  await page.locator('[data-map-channel="4"]').selectOption('blue');
  await page.locator('#import-material-scale').fill('3');
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText('Preview ready', {
    timeout: 30000,
  });
  await expect(page.locator('#material-preview canvas')).toBeVisible();
  await page.screenshot({
    path: info.outputPath('material-import-review.png'),
  });
  await page.evaluate(() => {
    window.importFailHistory = true;
  });
  await page.locator('.import-apply').click();
  await expect(page.locator('.import-status')).toContainText(
    'Injected import history failure',
  );
  await page.evaluate(() => {
    window.importFailHistory = false;
  });
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0);
  const imported = await save(page, info, 'material-after');
  const layer = imported.materials[0];
  expect(layer).toMatchObject({
    name: 'Meadow',
    color: '#ffffff',
    normalConvention: 'directx',
    tileSize: 3,
    roughness: 1,
    metalness: 1,
  });
  expect(imported.paint).toEqual(original.paint);
  const bytes = Buffer.from(layer.textures.orm.split(',')[1], 'base64');
  const packed = await Promise.all(
    ['red', 'green', 'blue'].map(async (channel) =>
      Math.round(
        (
          await decodeHeightmapPNG(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
            false,
            channel,
          )
        ).values[0] * 255,
      ),
    ),
  );
  expect(packed).toEqual([64, 63, 20]);
  await expect(page.locator('[data-map-thumbnail]')).toHaveCount(3);
  await (await inspectorControl(page, '[data-clear-texture=normal]')).click();
  await expect(page.locator('[data-map-thumbnail=normal]')).toHaveCount(0);
  expect(
    (await save(page, info, 'material-normal-removed')).materials[0].textures
      .normal,
  ).toBeUndefined();
  await page.locator('#undo').click();
  expect(
    (await save(page, info, 'material-normal-restored')).materials,
  ).toEqual(imported.materials);
  await page.locator('#undo').click();
  expect((await save(page, info, 'material-undone')).materials).toEqual(
    original.materials,
  );
  await page.locator('#redo').click();
  await expect(page.locator('#save-state')).toHaveText('Saved locally', {
    timeout: 10000,
  });
  await page.reload();
  await page.locator('[data-tab=materials]').click();
  await expect(page.locator('#mat-name')).toHaveValue('Meadow');
  expect((await save(page, info, 'material-restored')).materials).toEqual(
    imported.materials,
  );
  expect(errors).toEqual([]);
});

test('cancels pending foliage preparation without editing history or autosave, and supports drop and compact layouts', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  const errors = await setup(page);
  await page.locator('#project-name').fill('Redo remains available');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  const original = await save(page, info, 'pending-before');
  await page.locator('[data-tab=foliage]').click();
  await (await inspectorControl(page, '#import-foliage')).click();
  await page
    .locator('#foliage-files')
    .setInputFiles('public/foliage/photoreal/ph-fern-b.glb');
  await expect(page.locator('.import-status')).toContainText('1 model ready');
  await page.evaluate(() => {
    window.importHoldBitmap = true;
  });
  await page.locator('.import-apply').click();
  await page.waitForFunction(() => window.importBitmapReleases.length > 0);
  await page.locator('.import-cancel').click();
  await page.evaluate(async () => {
    window.importHoldBitmap = false;
    await Promise.all(
      window.importBitmapReleases.splice(0).map((release) => release()),
    );
  });
  await expect(page.locator('#redo')).toBeEnabled();
  expect(await save(page, info, 'pending-after')).toEqual(original);
  await page.locator('#redo').click();
  await expect(page.locator('#project-name')).toHaveValue(
    'Redo remains available',
  );
  await page.setViewportSize({ width: 980, height: 680 });
  await page.locator('[data-tab=materials]').click();
  await (await inspectorControl(page, '#import-material-set')).click();
  await page.locator('#material-drop').evaluate(
    (element, base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([bytes], 'Dropped_BaseColor.png', { type: 'image/png' }),
      );
      element.dispatchEvent(
        new DragEvent('drop', { bubbles: true, dataTransfer: transfer }),
      );
    },
    solidPng(120, 90, 45).toString('base64'),
  );
  await expect(page.locator('[data-map-role="0"]')).toHaveValue('albedo');
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText('Preview ready');
  for (const selector of [
    '.import-header',
    '.import-footer',
    '.import-apply',
  ]) {
    const box = await page.locator(selector).boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(680);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(980);
  }
  await page.screenshot({
    path: info.outputPath('compact-material-import.png'),
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.asset-import')).toHaveCount(0);
  await expect(page.locator('#import-material-set')).toBeFocused();
  expect(errors).toEqual([]);
});

test('reviews ambiguous and invalid material maps without losing the redo branch, then retries', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors = await setup(page);
  await page.locator('#project-name').fill('Temporary');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await page.locator('[data-tab=materials]').click();
  const original = await save(page, info, 'cancel-before');
  await (await inspectorControl(page, '#import-material-set')).click();
  await page
    .locator('#material-files')
    .setInputFiles([
      png('stone_NormalGL.png', [128, 128, 255]),
      png('stone_NormalDX.png', [128, 128, 255]),
    ]);
  await expect(page.locator('.import-status')).toContainText(
    'Choose one normal',
  );
  await expect(page.locator('#preview-material')).toBeDisabled();
  await page.locator('[data-map-role="1"]').selectOption('ignore');
  await expect(page.locator('#import-normal')).toHaveValue('opengl');
  await page.locator('#material-files').setInputFiles({
    name: 'Stone_BaseColor.png',
    mimeType: 'image/png',
    buffer: Buffer.from('broken PNG'),
  });
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText(
    'Could not preview',
  );
  await expect(page.locator('.import-apply')).toBeDisabled();
  await page.locator('[data-remove-map="2"]').click();
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText('Preview ready');
  await page.locator('.import-cancel').click();
  await expect(page.locator('#redo')).toBeEnabled();
  expect(await save(page, info, 'cancel-after')).toEqual(original);
  await page.locator('#redo').click();
  await expect(page.locator('#project-name')).toHaveValue('Temporary');
  expect(errors).toEqual([]);
});

test('imports photoreal GLB variants into a new brush, checks scale, and undoes atomically', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  const errors = await setup(page);
  await page.locator('[data-tab=foliage]').click();
  const original = await save(page, info, 'foliage-before');
  await (await inspectorControl(page, '#import-foliage')).click();
  await page
    .locator('#foliage-files')
    .setInputFiles([
      'public/foliage/photoreal/ph-fern-b.glb',
      'public/foliage/photoreal/ph-fern-a.glb',
    ]);
  await expect(page.locator('.import-status')).toContainText('2 models ready', {
    timeout: 30000,
  });
  await expect(page.locator('#foliage-preview canvas')).toBeVisible();
  await expect(page.locator('#foliage-model-review')).toContainText(
    'Rico Cilliers',
  );
  await page.locator('#foliage-import-name').fill('Fern understory');
  await page.screenshot({ path: info.outputPath('foliage-import-review.png') });
  await page.locator('#foliage-import-mode').selectOption('replace');
  await expect(page.locator('.import-apply')).toBeDisabled();
  await page.locator('#foliage-import-mode').selectOption('new');
  await page.evaluate(() => {
    window.importFailHistory = true;
  });
  await page.locator('.import-apply').click();
  await expect(page.locator('.import-status')).toContainText(
    'Injected import history failure',
  );
  await page.evaluate(() => {
    window.importFailHistory = false;
  });
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0);
  await expect(page.locator('#brush-name')).toHaveValue('Fern understory');
  const imported = await save(page, info, 'foliage-after');
  expect(imported.brushes).toHaveLength(original.brushes.length + 1);
  expect(imported.brushes.at(-1).models).toHaveLength(2);
  expect(imported.brushes.slice(0, -1)).toEqual(original.brushes);
  expect(imported.foliage).toEqual(original.foliage);
  await page.locator('#undo').click();
  expect(await save(page, info, 'foliage-undone')).toEqual(original);
  await page.locator('#redo').click();
  await expect(page.locator('#save-state')).toHaveText('Saved locally', {
    timeout: 10000,
  });
  await page.reload();
  await page.locator('[data-tab=foliage]').click();
  const restored = await save(page, info, 'foliage-restored');
  expect(restored.brushes).toEqual(imported.brushes);
  expect(restored.assets).toEqual(imported.assets);
  expect(errors).toEqual([]);
});

test('packages glTF dependencies after an actionable error and converts units and pivot without touching old plants', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors = await setup(page);
  const glb = triangleGlb({ height: 100, translation: [50, 20, 0] });
  const length = glb.readUInt32LE(12),
    json = JSON.parse(glb.toString('utf8', 20, 20 + length));
  json.buffers[0].uri = 'geometry/plant.bin';
  json.asset.copyright = 'Fixture Artist';
  const file = {
    name: 'plant.gltf',
    mimeType: 'model/gltf+json',
    buffer: Buffer.from(JSON.stringify(json)),
  };
  const bin = {
    name: 'plant.bin',
    mimeType: 'application/octet-stream',
    buffer: glb.subarray(20 + length + 8),
  };
  await page.locator('[data-tab=foliage]').click();
  await (await inspectorControl(page, '#import-foliage')).click();
  await page.locator('#foliage-files').setInputFiles(file);
  await expect(page.locator('.import-status')).toContainText(
    'Missing dependency',
  );
  await expect(page.locator('.import-apply')).toBeDisabled();
  await page.locator('#foliage-files').setInputFiles([file, bin]);
  await expect(page.locator('.import-status')).toContainText('1 model ready');
  await page.locator('#foliage-import-units').selectOption('0.01');
  await expect(page.locator('#foliage-model-review')).toContainText(
    '0.04 × 1 × 0 m',
  );
  await page.locator('#foliage-import-mode').selectOption('add');
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0);
  const imported = await save(page, info, 'gltf-imported');
  const asset = Object.values(imported.assets)[0];
  const bytes = Buffer.from(asset.data.split(',')[1], 'base64');
  const model = JSON.parse(
    bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)),
  );
  expect(model.asset.copyright).toBe('Fixture Artist');
  expect(model.buffers[0].uri).toContain('data:');
  expect(model.nodes.at(-1)).toMatchObject({
    scale: [0.01, 0.01, 0.01],
    translation: [-0.5, -0.2, 0],
  });
  expect(imported.brushes[0].models).toHaveLength(2);
  expect(errors).toEqual([]);
});
