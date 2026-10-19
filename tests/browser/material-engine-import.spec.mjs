import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProject,
  serializeProject,
  encodeRgbaPNG,
  encodeHeightmapPNG,
  decodeHeightmapPNG,
} from 'terrain-tools';
import { solidPng, decodeDocument } from './fixtures.mjs';

async function png(name, rgba) {
  return {
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(await encodeRgbaPNG(1, 1, new Uint8Array(rgba))),
  };
}
async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function pixel(url) {
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return Promise.all(
    ['red', 'green', 'blue'].map(async (channel) =>
      Math.round(
        (await decodeHeightmapPNG(data, false, channel)).values[0] * 255,
      ),
    ),
  );
}
async function setup(page, retainedNormal = false) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const Original = window.Uint8Array;
    window.Uint8Array = new Proxy(Original, {
      construct(target, args, constructor) {
        if (
          window.engineHistoryFailure &&
          args.length === 3 &&
          args[2] === 4356
        )
          throw new RangeError('Injected engine import history failure');
        return Reflect.construct(target, args, constructor);
      },
    });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.imageProcessor = /^(blob:|data:)/.test(String(url));
      }
      postMessage(...args) {
        if (this.imageProcessor && window.holdEnginePacking)
          window.releaseEnginePacking = () => super.postMessage(...args);
        else super.postMessage(...args);
      }
    };
  });
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 30000,
  });
  const project = createProject(32, 64);
  project.heights.fill(0);
  project.view.water = false;
  project.view.textureResolution = 256;
  if (retainedNormal) {
    project.materials[0].normalConvention = 'directx';
    project.materials[0].textures.normal =
      'data:image/png;base64,' + solidPng(128, 100, 240).toString('base64');
  }
  await page.locator('#file-open').setInputFiles({
    name: 'engine-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await page.locator('[data-tab=materials]').click();
  return errors;
}
async function preview(page) {
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText('Preview ready', {
    timeout: 30000,
  });
}
async function apply(page) {
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0);
}

for (const preset of ['blender', 'unreal', 'unity', 'unity-hdrp']) {
  test(`${preset} import produces the correct normal convention and numeric ORM, with undo`, async ({
    page,
  }, info) => {
    const errors = await setup(page);
    const before = await save(page, info, 'before');
    await (await inspectorControl(page, '#import-material-set')).click();
    await page.locator('#import-engine').selectOption(preset);
    const maps = [await png('Stone_Normal.png', [128, 100, 240, 255])];
    if (preset === 'blender')
      maps.push(
        await png('Stone_AO.png', [102, 102, 102, 255]),
        await png('Stone_Roughness.png', [51, 51, 51, 255]),
        await png('Stone_Metalness.png', [17, 17, 17, 255]),
      );
    if (preset === 'unreal')
      maps.push(await png('Stone_ORM.png', [102, 51, 17, 255]));
    if (preset === 'unity')
      maps.push(
        await png('Stone_Metallic.png', [17, 40, 77, 204]),
        await png('Stone_Occlusion.png', [250, 102, 11, 255]),
      );
    if (preset === 'unity-hdrp')
      maps.push(await png('Stone_MaskMap.png', [17, 102, 153, 204]));
    await page.locator('#material-files').setInputFiles(maps);
    await expect(page.locator('#import-normal')).toHaveValue(
      preset === 'unreal' ? 'directx' : 'opengl',
    );
    if (preset.startsWith('unity'))
      await expect(page.locator('#import-gloss')).toBeChecked();
    else await expect(page.locator('#import-gloss')).not.toBeChecked();
    await preview(page);
    await page.screenshot({ path: info.outputPath('engine-review.png') });
    await apply(page);
    const imported = await save(page, info, 'imported');
    expect(imported.materials[0]).toMatchObject({
      normalConvention: preset === 'unreal' ? 'directx' : 'opengl',
      roughness: 1,
      metalness: 1,
    });
    expect(await pixel(imported.materials[0].textures.orm)).toEqual([
      102, 51, 17,
    ]);
    expect(imported.paint).toEqual(before.paint);
    await page.locator('#undo').click();
    await expect(page.locator('#preparation-status')).toBeHidden();
    expect((await save(page, info, 'undone')).materials).toEqual(
      before.materials,
    );
    if (preset === 'unity-hdrp') {
      await page.locator('#redo').click();
      await expect(page.locator('#save-state')).toHaveText('Saved locally');
      await page.reload();
      await expect(page.locator('#app')).not.toHaveAttribute('inert');
      expect((await save(page, info, 'restored')).materials).toEqual(
        imported.materials,
      );
    }
    expect(errors).toEqual([]);
  });
}

test('reviews presets and manual overrides, rejects missing alpha, and recovers cancellation and failed apply', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors = await setup(page);
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#redo')).toBeEnabled();
  const before = await save(page, info, 'before');
  const undo = await page.locator('#undo').getAttribute('title');
  const redo = await page.locator('#redo').getAttribute('title');
  await (await inspectorControl(page, '#import-material-set')).click();
  await page.locator('#material-files').setInputFiles({
    name: 'Stone_MaskMap.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      await encodeHeightmapPNG({
        width: 1,
        height: 1,
        values: new Float32Array([0.4]),
      }),
    ),
  });
  await expect(page.locator('[data-map-role="0"]')).toHaveValue('ignore');
  await page.locator('#import-engine').selectOption('unity-hdrp');
  await expect(page.locator('[data-map-role="0"]')).toHaveValue('hdrp-mask');
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText(
    'no alpha channel',
  );
  await expect(page.locator('.import-apply')).toBeDisabled();
  await page.locator('[data-remove-map="0"]').click();
  await page
    .locator('#material-files')
    .setInputFiles([
      await png('Stone_MaskMap.png', [17, 102, 153, 0]),
      await png('Stone_Normal.png', [128, 100, 240, 255]),
    ]);
  await page.evaluate(() => (window.holdEnginePacking = true));
  await page.locator('#preview-material').click();
  await page.waitForFunction(() => !!window.releaseEnginePacking);
  await page.locator('.import-cancel').click();
  await page.evaluate(() => {
    window.holdEnginePacking = false;
    window.releaseEnginePacking();
  });
  expect(await save(page, info, 'cancelled')).toEqual(before);
  expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
  await (await inspectorControl(page, '#import-material-set')).click();
  await page.locator('#import-engine').selectOption('unity-hdrp');
  await page
    .locator('#material-files')
    .setInputFiles([
      await png('Stone_MaskMap.png', [17, 102, 153, 0]),
      await png('Stone_Normal.png', [128, 100, 240, 255]),
    ]);
  await preview(page);
  await page.locator('#import-engine').selectOption('blender');
  await expect(page.locator('.import-apply')).toBeDisabled();
  await expect(page.locator('[data-map-role="0"]')).toHaveValue('ignore');
  await page.locator('[data-map-role="0"]').selectOption('hdrp-mask');
  await page.locator('#import-engine').selectOption('unreal');
  await expect(page.locator('[data-map-role="0"]')).toHaveValue('hdrp-mask');
  await expect(page.locator('#import-normal')).toHaveValue('directx');
  await page.locator('#import-normal').selectOption('opengl');
  await page
    .locator('#material-files')
    .setInputFiles(await png('Stone_Height.png', [100, 100, 100, 255]));
  await expect(page.locator('#import-normal')).toHaveValue('opengl');
  await preview(page);
  await page.evaluate(() => (window.engineHistoryFailure = true));
  await page.locator('.import-apply').click();
  await expect(page.locator('.import-status')).toContainText(
    'Injected engine import history failure',
  );
  expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
  await page.evaluate(() => (window.engineHistoryFailure = false));
  await apply(page);
  const imported = await save(page, info, 'retry');
  expect(imported.materials[0].normalConvention).toBe('opengl');
  expect(await pixel(imported.materials[0].textures.orm)).toEqual([
    102, 255, 17,
  ]);
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect((await save(page, info, 'undone')).materials).toEqual(
    before.materials,
  );
  expect(errors).toEqual([]);
});

test('preserves a retained normal map convention when importing only numeric maps from another engine', async ({
  page,
}, info) => {
  await setup(page, true);
  const before = await save(page, info, 'before');
  await (await inspectorControl(page, '#import-material-set')).click();
  await page.locator('#import-engine').selectOption('blender');
  await page
    .locator('#material-files')
    .setInputFiles(await png('Stone_RMA.png', [51, 17, 102, 255]));
  await page.locator('.import-advanced summary').click();
  await page.locator('#import-replace').uncheck();
  await preview(page);
  await apply(page);
  const imported = await save(page, info, 'retained-normal');
  expect(imported.materials[0].normalConvention).toBe('directx');
  expect(imported.materials[0].textures.normal).toBe(
    before.materials[0].textures.normal,
  );
  expect(await pixel(imported.materials[0].textures.orm)).toEqual([
    102, 51, 17,
  ]);
});
