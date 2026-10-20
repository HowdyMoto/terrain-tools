import { test, expect } from '@playwright/test';
import { open, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseProjectFile } from 'terrain-tools';
import { triangleGlb } from './fixtures.mjs';
import { seedEditorProject } from './seed-editor-project.mjs';
import { inspectorControl } from './inspector-controls.mjs';

// Valid GLB with a large unused BIN tail: tests byte admission/persistence,
// separately from GPU-heavy production-asset validation. No large binary fixture
// is checked in, and the file is written without allocating its entire tail.
async function largeModel(path, payloadBytes) {
  const tiny = triangleGlb();
  const json = JSON.parse(
    tiny.toString('utf8', 20, 20 + tiny.readUInt32LE(12)),
  );
  json.buffers[0].byteLength = payloadBytes;
  const text = JSON.stringify(json);
  const padded = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' '));
  const total = 28 + padded.length + payloadBytes;
  const header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(payloadBytes);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const file = await open(path, 'w');
  try {
    await file.writev([
      header,
      padded,
      binHeader,
      tiny.subarray(tiny.length - 36),
    ]);
    await file.truncate(total);
    await file.write(Buffer.from([217]), 0, 1, total - 1);
  } finally {
    await file.close();
  }
  return total;
}

async function setup(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seedEditorProject(page);
  await page.addInitScript(() => {
    const Original = window.Uint8Array;
    window.Uint8Array = new Proxy(Original, {
      construct(target, args, constructor) {
        if (
          window.largeModelHistoryFault &&
          args.length === 3 &&
          args[2] === 4356
        )
          throw new RangeError('Injected large-model history failure');
        return Reflect.construct(target, args, constructor);
      },
    });
    Original.prototype.constructor = window.Uint8Array;
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (file) {
      if (window.holdLargeModelRead) {
        window.releaseLargeModelRead = () => read.call(this, file);
        return;
      }
      return read.call(this, file);
    };
  });
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 120000,
  });
  return errors;
}

async function save(page, info, name) {
  const pending = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  const bytes = await readFile(path);
  return parseProjectFile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

test('large prop imports preserve cancellation, failed preparation, retry, undo and autosave', async ({
  page,
}, info) => {
  test.setTimeout(240000);
  const source = info.outputPath('large-prop.glb');
  const sourceBytes = await largeModel(source, 34 * 1024 ** 2);
  const errors = await setup(page);
  await page.locator('#project-name').fill('Redo must survive');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await page.locator('[data-tab=props]').click();
  await expect(page.locator('#redo')).toBeEnabled();
  await page.evaluate(() => {
    window.holdLargeModelRead = true;
  });
  await page.locator('#asset-open').setInputFiles(source);
  await page.waitForFunction(() => window.releaseLargeModelRead);
  await page.locator('#cancel-preparation').click();
  await page.evaluate(() => {
    window.holdLargeModelRead = false;
    window.releaseLargeModelRead();
  });
  await expect(page.locator('#redo')).toBeEnabled();
  expect(
    Object.keys((await save(page, info, 'cancelled')).assets),
  ).toHaveLength(0);
  await page.evaluate(() => {
    window.largeModelHistoryFault = true;
  });
  await page.locator('#asset-open').setInputFiles(source);
  await expect(page.locator('#toast')).toContainText(
    'Injected large-model history failure',
    { timeout: 60000 },
  );
  await expect(page.locator('#redo')).toBeEnabled();
  expect(Object.keys((await save(page, info, 'failed')).assets)).toHaveLength(
    0,
  );
  await page.evaluate(() => {
    window.largeModelHistoryFault = false;
  });
  await page.locator('#asset-open').setInputFiles(source);
  await expect(page.locator('#toast')).toHaveText('Model imported.', {
    timeout: 60000,
  });
  const imported = await save(page, info, 'imported');
  const data = Object.values(imported.assets)[0].data;
  expect(Buffer.from(data.slice(data.indexOf(',') + 1), 'base64').length).toBe(
    sourceBytes,
  );
  await page.locator('#undo').click();
  await expect(page.locator('#asset-usage')).toContainText('0.0 / 384');
  await page.locator('#redo').click();
  await expect(page.locator('#asset-usage')).toContainText('34.0 / 384');
  await expect(page.locator('#save-state')).toHaveText('Saved locally', {
    timeout: 60000,
  });
  await page.reload();
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 120000,
  });
  const restored = await save(page, info, 'restored');
  expect(Object.values(restored.assets)[0].data === data).toBe(true);
  expect(errors).toEqual([]);
});

// Opt-in artist-owned source, kept outside the repository. The deterministic
// tests remain independent of local downloads and their licenses.
test('artist GLB previews, preserves source geometry/textures, and reopens from a project', async ({
  page,
}, info) => {
  const source = process.env.TERRAIN_TEST_GLB;
  test.skip(!source, 'Set TERRAIN_TEST_GLB to a local static GLB.');
  test.setTimeout(300000);
  const original = await readFile(source);
  const binaryHash = (bytes) => {
    const jsonLength = bytes.readUInt32LE(12);
    return createHash('sha256')
      .update(bytes.subarray(20 + jsonLength))
      .digest('hex');
  };
  const errors = await setup(page);
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const gpu = await page.locator('#fps').getAttribute('title');
  await page.locator('[data-tab=foliage]').click();
  await (await inspectorControl(page, '#import-foliage')).click();
  const started = Date.now();
  await page.locator('#foliage-files').setInputFiles(source);
  await expect(page.locator('.import-status')).toContainText('1 model ready', {
    timeout: 120000,
  });
  await expect(page.locator('#foliage-preview canvas')).toBeVisible();
  await page.locator('#foliage-import-name').fill('Large artist model');
  await page.locator('#foliage-import-profile').selectOption('tree');
  const review = await page.locator('#foliage-model-review').textContent();
  const previewMs = Date.now() - started;
  await page.screenshot({ path: info.outputPath('artist-model-preview.png') });
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0, {
    timeout: 120000,
  });
  const imported = await save(page, info, 'artist-model');
  const data = Object.values(imported.assets)[0].data;
  const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  expect(binaryHash(bytes)).toBe(binaryHash(original));
  expect(imported.brushes.at(-1).name).toBe('Large artist model');
  await expect(page.locator('#save-state')).toHaveText('Saved locally', {
    timeout: 60000,
  });
  await page.reload();
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 120000,
  });
  const restored = await save(page, info, 'artist-autosave-restored');
  expect(Object.values(restored.assets)[0].data === data).toBe(true);
  await page
    .locator('#file-open')
    .setInputFiles(info.outputPath('artist-model.terrain'));
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 120000,
  });
  const reopened = await save(page, info, 'artist-file-reopened');
  expect(Object.values(reopened.assets)[0].data === data).toBe(true);
  await writeFile(
    info.outputPath('artist-model-report.json'),
    JSON.stringify(
      {
        source: basename(source),
        sourceBytes: original.length,
        savedModelBytes: bytes.length,
        gpu,
        review,
        previewMs,
        binaryPayloadPreserved: true,
        autosaveReload: true,
        nativeFileReopen: true,
        errors,
        scope:
          'One source model preview/import/persistence; not a dense-scene performance benchmark.',
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
});

test('foliage previews and persists a 128 MiB GLB beyond the old per-model and batch limits', async ({
  page,
}, info) => {
  test.setTimeout(240000);
  const source = info.outputPath('large-foliage.glb');
  const sourceBytes = await largeModel(source, 128 * 1024 ** 2);
  const errors = await setup(page);
  await page.locator('[data-tab=foliage]').click();
  await (await inspectorControl(page, '#import-foliage')).click();
  await page.locator('#foliage-files').setInputFiles(source);
  await expect(page.locator('.import-status')).toContainText('1 model ready', {
    timeout: 120000,
  });
  await expect(page.locator('#foliage-preview canvas')).toBeVisible();
  await page.locator('#foliage-import-name').fill('Large source foliage');
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0, {
    timeout: 120000,
  });
  const imported = await save(page, info, 'large-foliage');
  expect(imported.brushes.at(-1).name).toBe('Large source foliage');
  const model = Object.values(imported.assets)[0];
  const bytes = Buffer.from(
    model.data.slice(model.data.indexOf(',') + 1),
    'base64',
  );
  expect(bytes.length).toBeGreaterThanOrEqual(sourceBytes);
  expect(bytes.at(-1)).toBe(217);
  await expect(page.locator('#save-state')).toHaveText('Saved locally', {
    timeout: 60000,
  });
  await page.reload();
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 120000,
  });
  await page.locator('[data-tab=foliage]').click();
  await expect(page.locator('#asset-usage')).toContainText('128.0 / 384');
  await writeFile(
    info.outputPath('large-model-report.json'),
    JSON.stringify(
      {
        sourceBytes,
        savedModelBytes: bytes.length,
        fixture:
          'triangle with unused binary payload; file-size/persistence coverage, not photorealistic GPU stress',
        errors,
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
});
