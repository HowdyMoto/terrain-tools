import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  createProject,
  serializeProject,
  decodeHeightmapPNG,
} from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';
import { tiffFixture, tgaFixture } from '../texture-fixtures.ts';

const file = (name, buffer) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from(buffer),
});
async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function pixel(url) {
  expect(url).toMatch(/^data:image\/png;base64,/);
  const bytes = new Uint8Array(Buffer.from(url.split(',')[1], 'base64')).buffer;
  return Promise.all(
    ['red', 'green', 'blue', 'alpha'].map(async (channel) =>
      Math.round(
        (await decodeHeightmapPNG(bytes, false, channel)).values[0] * 255,
      ),
    ),
  );
}
async function setup(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const Original = window.Uint8Array;
    window.Uint8Array = new Proxy(Original, {
      construct(target, args, constructor) {
        if (window.failFormatHistory && args.length === 3 && args[2] === 4356)
          throw new RangeError('Injected texture import history failure');
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
        if (this.imageProcessor && window.holdFormatWorker)
          window.releaseFormatWorker = () => super.postMessage(...args);
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
  await page
    .locator('#file-open')
    .setInputFiles(
      file('formats.json', Buffer.from(serializeProject(project))),
    );
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

for (const format of ['TIFF', 'TGA'])
  test(`mixed texture set with ${format} Unity alpha survives preview, history and autosave`, async ({
    page,
  }, info) => {
    const errors = await setup(page);
    const baseline = await save(page, info, 'baseline');
    await (await inspectorControl(page, '#import-material-set')).click();
    await page.locator('#import-engine').selectOption('unity-hdrp');
    await page
      .locator('#material-files')
      .setInputFiles([
        file('Rock_BaseColor.tif', tiffFixture({ pixels: [100, 80, 60, 255] })),
        file('Rock_Normal.TGA', tgaFixture({ pixels: [240, 100, 128, 255] })),
        file(
          'Rock_Displacement.tiff',
          tiffFixture({ channels: 1, bits: 16, pixels: [32768] }),
        ),
        format === 'TIFF'
          ? file(
              'Rock_MaskMap.TIFF',
              tiffFixture({ bits: 16, pixels: [4369, 26214, 39321, 0] }),
            )
          : file(
              'Rock_MaskMap.TGA',
              tgaFixture({ type: 10, pixels: [128, 153, 102, 17, 0] }),
            ),
      ]);
    await expect(page.locator('.import-source-format')).toHaveCount(4);
    await preview(page);
    await expect(page.locator('.import-source img')).toHaveCount(4);
    expect(
      await page
        .locator('.import-source img')
        .evaluateAll((images) =>
          images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('converted-preview.png') });
    await apply(page);
    const imported = await save(page, info, 'imported');
    expect(await pixel(imported.materials[0].textures.orm)).toEqual([
      102, 255, 17, 255,
    ]);
    expect(await pixel(imported.materials[0].textures.albedo)).toEqual([
      100, 80, 60, 255,
    ]);
    expect(await pixel(imported.materials[0].textures.normal)).toEqual([
      128, 100, 240, 255,
    ]);
    expect(await pixel(imported.materials[0].textures.height)).toEqual([
      128, 128, 128, 255,
    ]);
    expect(imported.heights).toEqual(baseline.heights);
    await page.locator('#undo').click();
    await expect(page.locator('#preparation-status')).toBeHidden();
    expect((await save(page, info, 'undo')).materials).toEqual(
      baseline.materials,
    );
    await page.locator('#redo').click();
    await expect(page.locator('#save-state')).toHaveText('Saved locally');
    await page.reload();
    await expect(page.locator('#app')).not.toHaveAttribute('inert', {
      timeout: 30000,
    });
    expect((await save(page, info, 'reloaded')).materials).toEqual(
      imported.materials,
    );
    expect(errors).toEqual([]);
  });

test('conversion errors, cancellation and failed application preserve history and allow retry', async ({
  page,
}, info) => {
  const errors = await setup(page);
  const baseline = await save(page, info, 'baseline');
  const undo = await page.locator('#undo').getAttribute('title');
  const redo = await page.locator('#redo').getAttribute('title');
  await (await inspectorControl(page, '#import-material-set')).click();
  await page
    .locator('#material-files')
    .setInputFiles(file('Rock_BaseColor.tga', tgaFixture().slice(0, -1)));
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText('truncated TGA');
  await expect(page.locator('.import-apply')).toBeDisabled();
  await page.locator('[data-remove-map="0"]').click();
  await page.locator('#import-engine').selectOption('unity-hdrp');
  await page
    .locator('#material-files')
    .setInputFiles(
      file(
        'Rock_MaskMap.tif',
        tiffFixture({ channels: 3, pixels: [17, 102, 153] }),
      ),
    );
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText(
    'no alpha channel',
  );
  await expect(page.locator('.import-apply')).toBeDisabled();
  await page.locator('[data-remove-map="0"]').click();
  const good = file('Rock_MaskMap.tga', tgaFixture());
  await page.locator('#material-files').setInputFiles(good);
  await page.evaluate(() => (window.holdFormatWorker = true));
  await page.locator('#preview-material').click();
  await page.waitForFunction(() => !!window.releaseFormatWorker);
  await page.locator('.import-cancel').click();
  await page.evaluate(() => {
    window.holdFormatWorker = false;
    window.releaseFormatWorker();
  });
  expect(await save(page, info, 'cancelled')).toEqual(baseline);
  await (await inspectorControl(page, '#import-material-set')).click();
  await page.locator('#import-engine').selectOption('unity-hdrp');
  await page.locator('#material-files').setInputFiles(good);
  await preview(page);
  await page.evaluate(() => (window.failFormatHistory = true));
  await page.locator('.import-apply').click();
  await expect(page.locator('.import-status')).toContainText(
    'Injected texture import history failure',
  );
  expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
  await page.evaluate(() => (window.failFormatHistory = false));
  await apply(page);
  expect(
    await pixel((await save(page, info, 'retry')).materials[0].textures.orm),
  ).toEqual([102, 51, 17, 255]);
  expect(errors).toEqual([]);
});

test('individual slots and ORM composer accept desktop formats, with failed decode and cancellation recovery', async ({
  page,
}, info) => {
  const errors = await setup(page);
  const baseline = await save(page, info, 'baseline');
  await (await inspectorControl(page, '[data-texture=height]')).click();
  await page
    .locator('#texture-open')
    .setInputFiles(file('height.tif', tiffFixture().slice(0, -1)));
  await expect(page.locator('#toast')).toContainText('truncated TIFF');
  expect(await save(page, info, 'failed')).toEqual(baseline);
  await page.evaluate(() => (window.holdFormatWorker = true));
  await (await inspectorControl(page, '[data-texture=height]')).click();
  const height = file(
    'height.tif',
    tiffFixture({ channels: 1, bits: 16, pixels: [26214] }),
  );
  await page.locator('#texture-open').setInputFiles(height);
  await page.waitForFunction(() => !!window.releaseFormatWorker);
  await page.locator('#cancel-preparation').click();
  await page.evaluate(() => {
    window.holdFormatWorker = false;
    window.releaseFormatWorker();
  });
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, info, 'cancelled')).toEqual(baseline);
  await (await inspectorControl(page, '[data-texture=height]')).click();
  await page.locator('#texture-open').setInputFiles(height);
  await expect(page.locator('#toast')).toHaveText('Texture imported.');
  expect(
    await pixel(
      (await save(page, info, 'height')).materials[0].textures.height,
    ),
  ).toEqual([102, 102, 102, 255]);
  await (await inspectorControl(page, '[data-texture=normal]')).click();
  await page
    .locator('#texture-open')
    .setInputFiles(
      file('normal.tga', tgaFixture({ pixels: [240, 100, 128, 255] })),
    );
  await expect(page.locator('#toast')).toHaveText('Texture imported.');
  await (await inspectorControl(page, '#build-orm')).click();
  await page.locator('#orm-occlusion').setInputFiles(height);
  await page
    .locator('#orm-roughness')
    .setInputFiles(file('smooth.tga', tgaFixture({ pixels: [0, 0, 0, 64] })));
  await page.locator('#orm-channel-roughness').selectOption('alpha');
  await page.locator('#orm-gloss').check();
  await page
    .locator('#orm-metalness')
    .setInputFiles(
      file(
        'metal.tiff',
        tiffFixture({ channels: 1, bits: 16, pixels: [4355] }),
      ),
    );
  await page.locator('#orm-preview').click();
  await expect(page.locator('#orm-apply')).toBeEnabled();
  await page.locator('#orm-apply').click();
  await expect(page.locator('#orm-dialog')).toHaveCount(0);
  const imported = await save(page, info, 'composed');
  expect(await pixel(imported.materials[0].textures.orm)).toEqual([
    102, 191, 17, 255,
  ]);
  expect(await pixel(imported.materials[0].textures.normal)).toEqual([
    128, 100, 240, 255,
  ]);
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect((await save(page, info, 'undo')).materials[0].textures.orm).toEqual(
    baseline.materials[0].textures.orm,
  );
  expect(errors).toEqual([]);
});

test('4K uncompressed TGA imports beyond 20 MB, packs channels and survives native save, undo and reload', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const errors = await setup(page);
  const path = info.outputPath('Large_BaseColor.tga');
  const pixels = 4096 * 4096,
    tga = Buffer.alloc(18 + pixels * 4);
  tga[2] = 2;
  tga.writeUInt16LE(4096, 12);
  tga.writeUInt16LE(4096, 14);
  tga[16] = 32;
  tga[17] = 40;
  let seed = 12345;
  for (let i = 18; i < tga.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    tga[i] = seed & 255;
    tga[i + 1] = (seed >>> 8) & 255;
    tga[i + 2] = seed >>> 24;
    tga[i + 3] = 255;
  }
  await writeFile(path, tga);
  expect(tga.length).toBe(67_108_882);
  await (await inspectorControl(page, '#build-orm')).click();
  await page.locator('#orm-occlusion').setInputFiles(path);
  await page.locator('#orm-preview').click();
  await expect(page.locator('#orm-apply')).toBeEnabled({ timeout: 60000 });
  const ao = await page
    .locator('[data-orm-preview=occlusion]')
    .evaluate(
      (canvas) => canvas.getContext('2d').getImageData(0, 0, 1, 1).data[0],
    );
  expect(ao).toBe(tga[20]);
  await page.locator('#orm-cancel').click();
  await (await inspectorControl(page, '#import-material-set')).click();
  await page.locator('#material-files').setInputFiles(path);
  await expect(page.locator('[data-map-role="0"]')).toHaveValue('albedo');
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText('Preview ready', {
    timeout: 90000,
  });
  await apply(page);
  const imported = await save(page, info, 'large-import');
  const url = imported.materials[0].textures.albedo;
  expect(url.length).toBeGreaterThan(28_000_000);
  const png = Buffer.from(url.split(',')[1], 'base64');
  const metadata = await sharp(png).metadata();
  expect([metadata.width, metadata.height]).toEqual([4096, 4096]);
  const first = await sharp(png)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer();
  expect([...first]).toEqual([tga[20], tga[19], tga[18], 255]);
  const hash = createHash('sha256').update(url).digest('hex');
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(
    (await save(page, info, 'large-undone')).materials[0].textures.albedo,
  ).toBeUndefined();
  await page.locator('#redo').click();
  await expect(page.locator('#save-state')).toHaveText('Saved locally', {
    timeout: 60000,
  });
  await page.reload();
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 60000,
  });
  const restored = (await save(page, info, 'large-restored')).materials[0]
    .textures.albedo;
  expect(createHash('sha256').update(restored).digest('hex')).toBe(hash);
  expect(errors).toEqual([]);
});

test('small files with oversized decoded dimensions fail before preview and allow replacement', async ({
  page,
}, info) => {
  const errors = await setup(page);
  const before = await save(page, info, 'before-dimensions');
  const png = Buffer.alloc(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12);
  png.writeUInt32BE(8192, 16);
  png.writeUInt32BE(8192, 20);
  await (await inspectorControl(page, '[data-texture=albedo]')).click();
  await page
    .locator('#texture-open')
    .setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#toast')).toContainText('16 megapixels');
  expect(await save(page, info, 'rejected-dimensions')).toEqual(before);
  await (await inspectorControl(page, '#import-material-set')).click();
  await page.locator('#material-files').setInputFiles({
    name: 'huge_BaseColor.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.locator('.import-status')).toContainText('16 megapixels');
  await expect(page.locator('.import-source img')).toHaveCount(0);
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText('16 megapixels');
  await expect(page.locator('.import-apply')).toBeDisabled();
  await page.locator('[data-remove-map="0"]').click();
  await page
    .locator('#material-files')
    .setInputFiles(file('valid_BaseColor.tga', tgaFixture()));
  await preview(page);
  await apply(page);
  expect(
    await pixel(
      (await save(page, info, 'dimensions-retry')).materials[0].textures.albedo,
    ),
  ).toEqual([17, 102, 153, 204]);
  expect(errors).toEqual([]);
});
