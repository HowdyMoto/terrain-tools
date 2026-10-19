import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { createProject, serializeProject } from 'terrain-tools';
import { readFile } from 'node:fs/promises';
import { solidPng, decodeDocument } from './fixtures.mjs';

async function setup(page) {
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const project = createProject(32, 64);
  project.view.textureResolution = 256;
  await page.locator('#file-open').setInputFiles({
    name: 'worker-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await page.locator('[data-tab=materials]').click();
}
const png = (name, value) => ({
  name,
  mimeType: 'image/png',
  buffer: solidPng(value, value, value),
});
async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}

test('material and legacy ORM previews work without separate hashed worker files after a rebuild', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await setup(page);
  let missingWorkerRequests = 0;
  await page.context().route('**/assets/orm-worker-*.js', (route) => {
    missingWorkerRequests++;
    return route.fulfill({
      status: 404,
      contentType: 'text/html',
      body: 'Removed by later build',
    });
  });
  const workers = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await (await inspectorControl(page, '#import-material-set')).click();
  await page.locator('#material-files').setInputFiles([
    png('dirtwithrocks_Ambient_Occlusion.png', 80),
    png('dirtwithrocks_Base_Color.png', 120),
    png('dirtwithrocks_Height.png', 100),
    png('dirtwithrocks_Normal-ogl.png', 128),
    {
      name: 'dirtwithrocks_Metallic.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      buffer: Buffer.from('unsupported Photoshop fixture'),
    },
  ]);
  await expect(page.locator('#material-file-notice')).toContainText(
    'Export Photoshop PSD maps as PNG',
  );
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText('Preview ready');
  await expect(page.locator('#material-file-notice')).toContainText(
    'dirtwithrocks_Metallic.psd',
  );
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0);
  const imported = await save(page, info, 'imported');
  expect(Object.keys(imported.materials[0].textures).sort()).toEqual([
    'albedo',
    'height',
    'normal',
    'orm',
  ]);
  await (await inspectorControl(page, '#build-orm')).click();
  await page.locator('#orm-roughness').setInputFiles(png('roughness.png', 180));
  await page.locator('#orm-preview').click();
  await expect(page.locator('#orm-apply')).toBeEnabled();
  expect(missingWorkerRequests).toBe(0);
  expect(workers.filter((url) => /^(blob:|data:)/.test(url))).toHaveLength(2);
  expect(workers.some((url) => /orm-worker-/.test(url))).toBe(false);
  await page.locator('#orm-cancel').click();
});

test('worker startup failures give an actionable message, preserve redo and retry without closing the import', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        if (window.failImageProcessor) {
          window.failImageProcessor = false;
          queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error')));
        }
      }
    };
  });
  await setup(page);
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  const original = await save(page, info, 'before');
  const history = await page.locator('#undo').getAttribute('title');
  await (await inspectorControl(page, '#import-material-set')).click();
  await page
    .locator('#material-files')
    .setInputFiles(png('dirt_Ambient_Occlusion.png', 80));
  await page.evaluate(() => {
    window.failImageProcessor = true;
  });
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText(
    'Refresh the editor',
  );
  await expect(page.locator('.import-status')).toContainText(
    'Your terrain has not changed',
  );
  await expect(page.locator('.import-apply')).toBeDisabled();
  expect(await page.locator('#undo').getAttribute('title')).toBe(history);
  await expect(page.locator('#redo')).toBeEnabled();
  await page.locator('#preview-material').click();
  await expect(page.locator('.import-status')).toContainText('Preview ready');
  await page.locator('.import-cancel').click();
  expect(await save(page, info, 'after')).toEqual(original);
  await page.locator('#redo').click();
  await expect(page.locator('#project-name')).toHaveValue('Redo branch');
});
