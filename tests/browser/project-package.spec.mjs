import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProject,
  serializeProject,
  serializeProjectPackage,
} from 'terrain-tools';
import { decodeDocument, triangleGlb } from './fixtures.mjs';
import { seedEditorProject } from './seed-editor-project.mjs';
async function download(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const file = await pending;
  expect(file.suggestedFilename()).toMatch(/\.terrain$/);
  const path = info.outputPath(name);
  await file.saveAs(path);
  return { path, bytes: await readFile(path) };
}
async function localData(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('terrain-studio', 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const data = await new Promise((resolve, reject) => {
        const r = db
          .transaction('projects')
          .objectStore('projects')
          .get('autosave');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return {
        blob: data instanceof Blob,
        bytes: Array.from(
          data instanceof Blob
            ? new Uint8Array(await data.arrayBuffer())
            : new TextEncoder().encode(data),
        ),
      };
    } finally {
      db.close();
    }
  });
}
test('explains content manifests, preserves the open document and retries with its terrain file', async ({
  page,
}, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  const project = createProject(16, 32);
  project.name = 'Current landscape';
  project.foliage = [];
  project.wind.enabled = false;
  project.view.water = false;
  project.view.textureResolution = 256;
  const originalBytes = Buffer.from(
    await serializeProjectPackage(project).arrayBuffer(),
  );
  await page.locator('#file-open').setInputFiles({
    name: 'Current.terrain',
    mimeType: 'application/octet-stream',
    buffer: originalBytes,
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await page.locator('#project-name').fill('An undoable edit');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const original = decodeDocument(
    (await download(page, info, 'before-manifest.terrain')).bytes,
  );
  const autosave = await localData(page);
  const history = await page
    .locator('#undo, #redo')
    .evaluateAll((buttons) =>
      buttons.map((b) => ({ title: b.title, disabled: b.disabled })),
    );
  for (const [kind, path] of [
    [undefined, 'exports/My Landscape.terrain'],
    ['terrain-content-manifest', 'exports/My Landscape.terrain'],
    ['terrain-content-manifest', 'My-Landscape.terrain'],
  ]) {
    await page.locator('#file-open').setInputFiles({
      name: kind ? 'content-manifest.json' : 'project.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ kind, project: path })),
    });
    await expect(page.locator('#toast')).toContainText(
      `This file is a content manifest. Open "${path}" instead.`,
    );
    await expect(page.locator('#project-name')).toHaveValue(project.name);
    expect(
      await page
        .locator('#undo, #redo')
        .evaluateAll((buttons) =>
          buttons.map((b) => ({ title: b.title, disabled: b.disabled })),
        ),
    ).toEqual(history);
    expect(await localData(page)).toEqual(autosave);
    expect(
      decodeDocument(
        (await download(page, info, 'after-manifest.terrain')).bytes,
      ),
    ).toEqual(original);
  }
  project.name = 'My Landscape';
  await page.locator('#file-open').setInputFiles({
    name: 'My Landscape.terrain',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(await serializeProjectPackage(project).arrayBuffer()),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue('Current landscape');
  await page.locator('#redo').click();
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('[data-tab="project"]').click();
  await expect(page.locator('#project-file-location')).toBeVisible();
  await expect(page.locator('#project-file-location')).toContainText('root');
  await expect(page.locator('#project-folder-layout')).toContainText('scenes/');
  await expect(page.locator('#project-save-location')).toContainText(
    'does not update',
  );
  await page.screenshot({ path: info.outputPath('project-files.png') });
  expect(errors).toEqual([]);
});
test('migrates legacy autosave, recovers package failures, cleans assets with undo, and survives failed local writes', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.rejectAutosave)
        throw new DOMException(
          'Injected storage quota failure',
          'QuotaExceededError',
        );
      return put.apply(this, args);
    };
  });
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  const project = createProject(32, 64);
  project.name = 'Legacy package recovery';
  project.foliage = [];
  project.view.textureResolution = 256;
  project.assets = {
    marker: {
      name: 'Marker',
      data: 'data:model/gltf-binary;base64,' + triangleGlb().toString('base64'),
    },
    unused: {
      name: 'Unused',
      data:
        'data:model/gltf-binary;base64,' +
        triangleGlb({ height: 6 }).toString('base64'),
    },
  };
  project.props = [
    {
      id: project.nextId++,
      model: 'marker',
      x: 0,
      z: 0,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 3,
    },
  ];
  const legacy = serializeProject(project);
  await page.evaluate(async (text) => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open('terrain-studio', 1);
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(text, 'autosave');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, legacy);
  await page.reload();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await expect(page.locator('#project-name')).toHaveValue(project.name, {
    timeout: 30000,
  });
  const original = await download(page, info, 'original.terrain');
  expect(decodeDocument(original.bytes)).toEqual(JSON.parse(legacy));
  await expect.poll(async () => (await localData(page)).blob).toBe(true);
  const history = await page.locator('#undo').getAttribute('title');
  const corrupt = Buffer.from(original.bytes);
  corrupt[20] ^= 1;
  await page.locator('#file-open').setInputFiles({
    name: 'corrupt.terrain',
    mimeType: 'application/octet-stream',
    buffer: corrupt,
  });
  await expect(page.locator('#toast')).toContainText('checksum');
  expect(await page.locator('#undo').getAttribute('title')).toBe(history);
  expect(
    decodeDocument((await download(page, info, 'unchanged.terrain')).bytes),
  ).toEqual(JSON.parse(legacy));
  await page.locator('[data-tab=props]').click();
  await expect(page.locator('#asset-usage')).toContainText('1 unused models');
  await (await inspectorControl(page, '#prune-assets')).click();
  await expect(page.locator('#toast')).toHaveText(
    'Unused model assets removed.',
  );
  await (await inspectorControl(page, '#asset-usage')).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('package-asset-cleanup.png') });
  const cleaned = decodeDocument(
    (await download(page, info, 'cleaned.terrain')).bytes,
  );
  expect(Object.keys(cleaned.assets)).toEqual(['marker']);
  await page.locator('#undo').click();
  await expect(page.locator('#asset-usage')).toContainText('1 unused models');
  expect(
    decodeDocument((await download(page, info, 'undo.terrain')).bytes),
  ).toEqual(JSON.parse(legacy));
  await page.locator('#redo').click();
  await expect(page.locator('#asset-usage')).toContainText('0 unused models');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.evaluate(() => {
    window.rejectAutosave = true;
  });
  await page.locator('#project-name').fill('Unsaved change');
  await page.locator('#project-name').press('Tab');
  await expect(page.locator('#save-state')).toHaveText('Save to file');
  const previous = await localData(page);
  expect(decodeDocument(previous.bytes).name).toBe(project.name);
  await page.evaluate(() => {
    window.rejectAutosave = false;
  });
  await page.locator('#project-name').fill('  Recovered package  ');
  await page.locator('#project-name').press('Tab');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await expect(page.locator('#project-name')).toHaveValue('Recovered package');
  const recovered = await download(page, info, 'recovered.terrain');
  expect(decodeDocument(recovered.bytes)).toEqual({
    ...cleaned,
    name: 'Recovered package',
  });
  const runtime = await context.newPage();
  runtime.on('pageerror', (error) => errors.push(error.message));
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances', {
    timeout: 30000,
  });
  await runtime.locator('#open-project').setInputFiles(recovered.path);
  await expect(runtime.locator('#status')).toContainText('Recovered package');
  expect(errors).toEqual([]);
});
