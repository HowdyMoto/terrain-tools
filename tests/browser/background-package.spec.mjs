import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { decodeDocument } from './fixtures.mjs';
import { seedEditorProject } from './seed-editor-project.mjs';

test('built public background writer preserves exact snapshots and recovers after validation failure', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const {
      createProject,
      BackgroundProjectWriter,
      ProjectPackageWriter,
      parseProjectPackage,
    } = await import('/__runtime_test/lib/core.js');
    const project = createProject(32, 64);
    project.assets.example = {
      name: 'Synthetic payload',
      data: 'data:model/gltf-binary;base64,' + 'AQID'.repeat(262144),
    };
    const expected = new ProjectPackageWriter().encode(project);
    const writer = new BackgroundProjectWriter();
    try {
      const savedName = project.name,
        savedHeight = project.heights[0];
      const saving = writer.encode(project);
      project.name = 'Edited while encoding';
      project.heights[0] += 1;
      const blob = await saving;
      const actual = new Uint8Array(await blob.arrayBuffer()),
        baseline = new Uint8Array(await expected.arrayBuffer());
      const restored = parseProjectPackage(actual.buffer);
      const exact =
        actual.length === baseline.length &&
        actual.every((value, index) => value === baseline[index]);
      const liveAttached =
        project.heights.byteLength > 0 && project.heights[0] !== savedHeight;
      const bad = { ...project, heights: project.heights.slice() };
      bad.heights[0] = NaN;
      let error = '';
      try {
        await writer.encode(bad);
      } catch (caught) {
        error = String(caught);
      }
      const recovered = parseProjectPackage(
        await (await writer.encode(project)).arrayBuffer(),
      );
      return {
        exact,
        liveAttached,
        snapshotName: restored.name,
        savedName,
        error,
        recoveredName: recovered.name,
        stats: writer.stats,
      };
    } finally {
      writer.dispose();
    }
  });
  expect(result.exact).toBe(true);
  expect(result.liveAttached).toBe(true);
  expect(result.snapshotName).toBe(result.savedName);
  expect(result.error).toContain('buffer');
  expect(result.recoveredName).toBe('Edited while encoding');
  expect(result.stats).toMatchObject({
    active: false,
    pending: 0,
    cachedAssets: 1,
  });
  expect(errors).toEqual([]);
});

test('editor stays editable while a save is held, coalesces autosaves, and downloads the clicked snapshot', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.packageMessages = [];
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.packageWriter = String(url).includes('project-package-worker');
      }
      postMessage(message, transfer) {
        if (this.packageWriter) {
          window.packageMessages.push({
            name: message.project.name,
            added: message.added.length,
          });
          if (window.crashNextPackage) {
            window.crashNextPackage = false;
            queueMicrotask(() =>
              this.dispatchEvent(
                new ErrorEvent('error', {
                  message: 'Injected encoding failure',
                  cancelable: true,
                }),
              ),
            );
            return;
          }
          if (window.holdNextPackage) {
            window.holdNextPackage = false;
            window.releasePackage = () => super.postMessage(message, transfer);
            return;
          }
        }
        super.postMessage(message, transfer);
      }
    };
  });
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  // Ensure a baseline autosave exists, then hold the next worker submission.
  await page.locator('#project-name').fill('Baseline save');
  await page.locator('#project-name').press('Tab');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.evaluate(() => {
    window.holdNextPackage = true;
    window.packageMessages = [];
  });
  const rename = async (name) => {
    await page.locator('#project-name').fill(name);
    await page.locator('#project-name').press('Tab');
  };
  await rename('Active autosave');
  await page.waitForFunction(() => typeof window.releasePackage === 'function');
  await rename('Superseded autosave');
  await page.waitForTimeout(750); // Allow the editor's 600 ms debounce to enqueue it.
  await rename('Clicked file snapshot');
  await page.waitForTimeout(750);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save').click();
  await expect(page.locator('#save')).toBeDisabled();
  await rename('Newest edited document');
  await page.waitForTimeout(750);
  await expect(page.locator('#project-name')).toHaveValue(
    'Newest edited document',
  );
  await page.evaluate(() => window.releasePackage());
  const download = await downloadPromise;
  const path = info.outputPath('clicked-snapshot.terrain');
  await download.saveAs(path);
  expect(download.suggestedFilename()).toBe('Clicked-file-snapshot.terrain');
  expect(decodeDocument(await readFile(path)).name).toBe(
    'Clicked file snapshot',
  );
  await expect(page.locator('#save')).toBeEnabled();
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const messages = await page.evaluate(() =>
    window.packageMessages.map((message) => message.name),
  );
  expect(messages).not.toContain('Superseded autosave');
  expect(messages.slice(0, 3)).toEqual([
    'Active autosave',
    'Clicked file snapshot',
    'Newest edited document',
  ]);
  await page.reload();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await expect(page.locator('#project-name')).toHaveValue(
    'Newest edited document',
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    window.crashNextPackage = true;
  });
  await rename('Unsaved after worker crash');
  await expect(page.locator('#save-state')).toHaveText('Save to file');
  const retainedName = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('terrain-studio', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const blob = await new Promise((resolve, reject) => {
      const request = db
        .transaction('projects')
        .objectStore('projects')
        .get('autosave');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    // Read just the package manifest; no runtime import or test hook is needed.
    const header = new DataView(await blob.slice(0, 32).arrayBuffer());
    const metadata = JSON.parse(
      await blob.slice(32, 32 + header.getUint32(12, true)).text(),
    );
    return metadata.project.name;
  });
  expect(retainedName).toBe('Newest edited document');
  await rename('Recovered after worker crash');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await expect(page.locator('#project-name')).toHaveValue(
    'Recovered after worker crash',
    { timeout: 30000 },
  );
  expect(errors).toEqual([]);
});
