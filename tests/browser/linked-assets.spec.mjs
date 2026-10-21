import { test, expect as nativeExpect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProject,
  environmentPreset,
  ProjectPackageWriter,
  parseProjectPackage,
} from 'terrain-tools';
import { seedEditorProject } from './seed-editor-project.mjs';
import { triangleGlb, decodeDocument } from './fixtures.mjs';
// Native shader preparation can exceed the default five-second UI assertion budget.
const expect = nativeExpect.configure({ timeout: 30000 });

function projectFixture() {
  const p = createProject(16, 32);
  p.name = 'Linked art';
  p.heights.fill(0);
  p.foliage = [];
  p.props = [];
  p.view.textureResolution = 256;
  p.view.water = false;
  p.wind.enabled = false;
  p.environment = environmentPreset('natural');
  p.environment.temporalAA = false;
  p.environment.ambientOcclusion.enabled = false;
  p.environment.timeOfDay.enabled = false;
  const glb = triangleGlb({ height: 3 });
  p.assets.tree = {
    name: 'Editable Tree',
    data: 'data:model/gltf-binary;base64,' + glb.toString('base64'),
    source: {
      path: 'prepared/Tree.glb',
      scale: 1,
      offset: [0, 0, 0],
      prepared: true,
    },
  };
  p.brushes[0].model = 'tree';
  p.brushes[0].wind = 0;
  p.brushes[0].crush = 0;
  p.foliage = [
    { id: 1, brushId: p.brushes[0].id, x: 5, z: 0, scale: 1, rotation: 0 },
  ];
  p.props = [
    {
      id: 2,
      model: 'tree',
      x: 0,
      z: 0,
      scale: 1,
      rotation: 0,
      yOffset: 0,
      cutHole: false,
      holeRadius: 1,
    },
  ];
  p.nextId = 3;
  p.folderId = '12345678-1234-4123-8123-123456789012';
  return { p, glb };
}
async function initializeFolder(page, document, glb) {
  await page.addInitScript(
    ({ project, model }) => {
      window.testFolderReady = (async () => {
        const origin = await navigator.storage.getDirectory();
        const root = await origin.getDirectoryHandle('artist-workspace', {
          create: true,
        });
        try {
          await root.getFileHandle('__initialized');
          return root;
        } catch (error) {
          if (error.name !== 'NotFoundError') throw error;
        }
        const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        const write = async (handle, content) => {
          const stream = await handle.createWritable();
          await stream.write(content);
          await stream.close();
        };
        await write(
          await root.getFileHandle('Landscape.terrain', { create: true }),
          bytes(project),
        );
        const prepared = await root.getDirectoryHandle('prepared', {
          create: true,
        });
        await write(
          await prepared.getFileHandle('Tree.glb', { create: true }),
          bytes(model),
        );
        await write(
          await root.getFileHandle('__initialized', { create: true }),
          'ready',
        );
        return root;
      })();
      window.showDirectoryPicker = () => window.testFolderReady;
      window.showOpenFilePicker = async () => {
        const root = await window.testFolderReady;
        return [
          await (
            await root.getDirectoryHandle('prepared')
          ).getFileHandle('Tree.glb'),
        ];
      };
    },
    {
      project: Buffer.from(await document.arrayBuffer()).toString('base64'),
      model: glb.toString('base64'),
    },
  );
}
async function replaceSource(page, bytes) {
  await page.evaluate(async (base64) => {
    const root = await window.testFolderReady;
    const handle = await (
      await root.getDirectoryHandle('prepared')
    ).getFileHandle('Tree.glb');
    const stream = await handle.createWritable();
    await stream.write(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    await stream.close();
  }, bytes.toString('base64'));
}
async function portable(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#folder-portable').click();
  const file = await pending;
  const path = info.outputPath(name + '.terrain');
  await file.saveAs(path);
  return decodeDocument(await readFile(path));
}
async function history(page) {
  return page
    .locator('#undo,#redo')
    .evaluateAll((buttons) =>
      buttons.map((b) => ({ disabled: b.disabled, title: b.title })),
    );
}
async function canvas(page) {
  return page.locator('#viewport canvas').evaluate(async (canvas) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return canvas.toDataURL();
  });
}
async function autosave(page) {
  await expect(page.locator('#save-state')).toHaveText(
    /Saved locally|Recovery saved|Saved to folder/,
  );
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('terrain-studio', 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const file = await new Promise((resolve, reject) => {
        const r = db
          .transaction('projects')
          .objectStore('projects')
          .get('autosave');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    } finally {
      db.close();
    }
  });
}

test('linked GLBs refresh painted foliage and props, reject broken revisions, undo, save and reopen current disk art', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { p, glb } = projectFixture();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await initializeFolder(
    page,
    new ProjectPackageWriter().encode(p, 'linked'),
    glb,
  );
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await page.locator('#open-folder').click();
  await expect(page.locator('#project-name')).toHaveValue('Linked art');
  await expect(page.locator('#toast')).toContainText('Project folder opened');
  await page.locator('[data-tab="project"]').click();
  await expect(page.locator('#folder-source')).toHaveText('prepared/Tree.glb');
  await page.locator('#frame').click();
  const original = await portable(page, info, 'original');
  const originalPixels = await canvas(page),
    originalHistory = await history(page),
    originalSave = await autosave(page);
  // Valid container, invalid accessor: fail during actual renderer model preparation.
  const broken = Buffer.from(glb);
  const size = broken.readUInt32LE(12),
    json = JSON.parse(broken.subarray(20, 20 + size).toString());
  json.accessors[0].count = 999999;
  const text = Buffer.from(JSON.stringify(json));
  const padded = Math.ceil(text.length / 4) * 4,
    oldBin = broken.subarray(20 + size);
  const invalid = Buffer.alloc(20 + padded + oldBin.length, 32);
  broken.copy(invalid, 0, 0, 20);
  invalid.writeUInt32LE(invalid.length, 8);
  invalid.writeUInt32LE(padded, 12);
  text.copy(invalid, 20);
  oldBin.copy(invalid, 20 + padded);
  await replaceSource(page, invalid);
  await expect(page.locator('#folder-status')).toContainText(
    /RangeError|length|buffer|bounds/i,
    { timeout: 20000 },
  );
  expect(await history(page)).toEqual(originalHistory);
  expect(await autosave(page)).toEqual(originalSave);
  expect(await portable(page, info, 'after-broken')).toEqual(original);
  expect(await canvas(page)).toBe(originalPixels);
  // Completing the export automatically retries, without another import or relink.
  const revised = triangleGlb({ height: 9 });
  await replaceSource(page, revised);
  await expect(page.locator('#toast')).toContainText('Updated 1 linked model', {
    timeout: 20000,
  });
  const updated = await portable(page, info, 'updated');
  expect(updated.assets.tree.data).toBe(
    'data:model/gltf-binary;base64,' + revised.toString('base64'),
  );
  expect(updated.foliage).toEqual(original.foliage);
  expect(updated.props).toEqual(original.props);
  expect(updated.brushes).toEqual(original.brushes);
  expect(await canvas(page)).not.toBe(originalPixels);
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await portable(page, info, 'undone')).toEqual(original);
  await page.waitForTimeout(4300); // Two metadata polls must not silently redo an undo.
  expect(await portable(page, info, 'still-undone')).toEqual(original);
  await page.locator('#redo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await portable(page, info, 'redone')).toEqual(updated);
  await page.locator('#save').click();
  await expect(page.locator('#toast')).toHaveText(
    'Project saved to its folder.',
  );
  const disk = await page.evaluate(async () => {
    const root = await window.testFolderReady;
    const file = await (
      await root.getFileHandle('Landscape.terrain')
    ).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const header = new DataView(bytes.buffer);
    return {
      version: header.getUint32(8, true),
      manifest: JSON.parse(
        new TextDecoder().decode(
          bytes.subarray(32, 32 + header.getUint32(12, true)),
        ),
      ),
      bytes: bytes.length,
    };
  });
  expect(disk.version).toBe(2);
  expect(disk.manifest.project.assets.tree.data).toEqual({
    external: 'prepared/Tree.glb',
  });
  expect(disk.manifest.chunks.filter((c) => c.kind === 'asset')).toHaveLength(
    0,
  );
  // Reopen reads a newer source even though the document itself was not saved again.
  const latest = triangleGlb({ height: 12 });
  await replaceSource(page, latest);
  await page.locator('#open-folder').click();
  await expect(page.locator('#toast')).toContainText('Project folder opened');
  const reopened = await portable(page, info, 'reopened');
  expect(reopened.assets.tree.data).toBe(
    'data:model/gltf-binary;base64,' + latest.toString('base64'),
  );
  expect(reopened.foliage).toEqual(original.foliage);
  expect(reopened.props).toEqual(original.props);
  await page.screenshot({ path: info.outputPath('linked-assets.png') });
  // Expected GLTFLoader rejection may log a console error, but must not escape as a page error.
  expect(errors).toEqual([]);
});

test('new folder conversion preserves the document on cancellation and failed writes, then retries in the same folder', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { p, glb } = projectFixture();
  delete p.folderId;
  delete p.assets.tree.source;
  const embedded = new ProjectPackageWriter().encode(p);
  await initializeFolder(page, embedded, glb);
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await page.locator('#file-open').setInputFiles({
    name: 'Original.terrain',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(await embedded.arrayBuffer()),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await page.locator('[data-tab="project"]').click();
  await page.evaluate(async () => {
    const root = await window.testFolderReady;
    await root.removeEntry('Landscape.terrain');
    const picker = window.showDirectoryPicker;
    window.showDirectoryPicker = () => {
      if (window.cancelFolder)
        throw new DOMException('Cancelled', 'AbortError');
      return picker();
    };
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      if (window.failProjectWrite && this.name === 'Linked-art.terrain')
        throw new DOMException(
          'Injected folder write failure',
          'QuotaExceededError',
        );
      return create.apply(this, args);
    };
    window.cancelFolder = true;
  });
  const old = await portable(page, info, 'before-folder');
  const oldHistory = await history(page),
    oldSave = await autosave(page);
  await page.locator('#folder-create').click();
  expect(await history(page)).toEqual(oldHistory);
  expect(await autosave(page)).toEqual(oldSave);
  await page.evaluate(() => {
    window.cancelFolder = false;
    window.failProjectWrite = true;
  });
  await page.locator('#folder-create').click();
  await expect(page.locator('#toast')).toContainText(
    'Injected folder write failure',
  );
  expect(await history(page)).toEqual(oldHistory);
  expect(await autosave(page)).toEqual(oldSave);
  expect(await portable(page, info, 'after-failed-folder')).toEqual(old);
  expect(
    await page.evaluate(async () => {
      const root = await window.testFolderReady;
      try {
        await root.getFileHandle('Linked-art.terrain');
        return true;
      } catch (error) {
        if (error.name !== 'NotFoundError') throw error;
        return false;
      }
    }),
  ).toBe(false);
  await page.evaluate(() => {
    window.failProjectWrite = false;
  });
  await page.locator('#folder-create').click();
  await expect(page.locator('#toast')).toContainText('Folder project saved');
  await expect(page.locator('#folder-source')).toHaveText(
    'prepared/models/tree-Editable-Tree.glb',
  );
  expect(await portable(page, info, 'folder-created')).toEqual(old);
  await page.locator('#save').click();
  await expect(page.locator('#toast')).toHaveText(
    'Project saved to its folder.',
  );
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  await expect(page.locator('#folder-watch')).toHaveCount(0);
  expect(await portable(page, info, 'folder-undone')).toEqual(old);
  await page.locator('#redo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  await expect(page.locator('#folder-watch')).toBeChecked();
  expect(await portable(page, info, 'folder-redone')).toEqual(old);
  await page.locator('#project-name').fill('Recovered unsaved edits');
  await page.locator('#project-name').press('Tab');
  await expect(page.locator('#save-state')).toHaveText(
    /Saved locally|Recovery saved|Saved to folder/,
  );
  await page.reload();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await expect(page.locator('#project-name')).toHaveValue(
    'Recovered unsaved edits',
  );
  await page.locator('[data-tab="project"]').click();
  await page.locator('#folder-reconnect').click();
  await expect(page.locator('#toast')).toContainText(
    'Recovered edits are preserved',
  );
  await expect(page.locator('#folder-watch')).toBeChecked();
  expect(await portable(page, info, 'reconnected')).toEqual({
    ...old,
    name: 'Recovered unsaved edits',
  });
});

test('converts an embedded folder project once, preserves a backup, creates linked brushes and refuses external save conflicts', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { p, glb } = projectFixture();
  delete p.folderId;
  delete p.assets.tree.source;
  const embedded = new ProjectPackageWriter().encode(p);
  await initializeFolder(page, embedded, glb);
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await page.locator('#open-folder').click();
  await expect(page.locator('#toast')).toContainText('Project folder opened');
  await page.locator('[data-tab="project"]').click();
  await page.locator('#folder-extract').click();
  await expect(page.locator('#toast')).toContainText('Models extracted');
  await expect(page.locator('#folder-source')).toContainText(
    'prepared/models/',
  );
  await page.locator('#save').click();
  await expect(page.locator('#toast')).toHaveText(
    'Project saved to its folder.',
  );
  const backup = await page.evaluate(async () => {
    const root = await window.testFolderReady;
    const scenes = await root.getDirectoryHandle('scenes');
    const files = [];
    for await (const handle of scenes.values())
      if (handle.kind === 'file')
        files.push(
          Array.from(
            new Uint8Array(await (await handle.getFile()).arrayBuffer()),
          ),
        );
    return files;
  });
  expect(backup).toHaveLength(1);
  expect(parseProjectPackage(Uint8Array.from(backup[0]).buffer)).toEqual(p);
  // The normal foliage review creates linked variants in a single import.
  await page.locator('[data-tab="foliage"]').click();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.locator('#import-foliage').click();
  await page.locator('#foliage-linked-files').click();
  await expect(page.locator('[data-inspect-model]')).toHaveCount(1);
  await page.locator('#foliage-import-ground').uncheck();
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 30000 });
  await page.locator('[data-tab="project"]').click();
  await page.locator('#save').click();
  await expect(page.locator('#toast')).toHaveText(
    'Project saved to its folder.',
  );
  const links = await page.evaluate(async () => {
    const root = await window.testFolderReady;
    const f = await (await root.getFileHandle('Landscape.terrain')).getFile();
    const h = new DataView(await f.slice(0, 32).arrayBuffer());
    return JSON.parse(await f.slice(32, 32 + h.getUint32(12, true)).text())
      .project.assets;
  });
  expect(
    Object.values(links).filter((m) => m.source?.path === 'prepared/Tree.glb'),
  ).toHaveLength(1);
  const beforeRetarget = await portable(page, info, 'before-retarget');
  await page.locator('#folder-model').selectOption('tree');
  await page.locator('#folder-link').click();
  await expect(page.locator('#folder-source')).toHaveText('prepared/Tree.glb');
  expect(await portable(page, info, 'retargeted')).toEqual(beforeRetarget);
  await page.locator('#folder-unlink').click();
  await expect(page.locator('#folder-source')).toContainText('Embedded model');
  expect(await portable(page, info, 'detached')).toEqual(beforeRetarget);
  await replaceSource(page, triangleGlb({ height: 7 }));
  await expect(page.locator('#toast')).toContainText('Updated 1 linked model', {
    timeout: 20000,
  });
  const afterDetachedChange = await portable(
    page,
    info,
    'detached-source-changed',
  );
  expect(afterDetachedChange.assets.tree.data).toBe(
    beforeRetarget.assets.tree.data,
  );
  expect(
    Object.entries(afterDetachedChange.assets).some(
      ([id, model]) =>
        id !== 'tree' && model.data !== beforeRetarget.assets[id].data,
    ),
  ).toBe(true);
  expect(afterDetachedChange.props).toEqual(beforeRetarget.props);
  expect(afterDetachedChange.brushes).toEqual(beforeRetarget.brushes);
  const before = await portable(page, info, 'before-conflict');
  await page.evaluate(async () => {
    const root = await window.testFolderReady;
    const stream = await (
      await root.getFileHandle('Landscape.terrain')
    ).createWritable();
    await stream.write('Artist edited the project externally');
    await stream.close();
  });
  await page.locator('#save').click();
  await expect(page.locator('#toast')).toContainText('changed on disk');
  expect(await portable(page, info, 'after-conflict')).toEqual(before);
  expect(
    await page.evaluate(async () => {
      const root = await window.testFolderReady;
      return (
        await (await root.getFileHandle('Landscape.terrain')).getFile()
      ).text();
    }),
  ).toBe('Artist edited the project externally');
});
