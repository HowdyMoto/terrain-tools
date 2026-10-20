import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseProjectFile } from 'terrain-tools';
import { seedEditorProject } from './seed-editor-project.mjs';
import { inspectorControl } from './inspector-controls.mjs';
import { triangleGlb } from './fixtures.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function setup(page) {
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 60000,
  });
  await page.locator('[data-tab=foliage]').click();
  await (await inspectorControl(page, '#import-foliage')).click();
}
async function save(page, info, name) {
  const pending = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  const data = await readFile(path);
  return parseProjectFile(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  );
}

test('dropping a glTF folder includes nested dependencies, permits cancellation and imports on retry', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  const glb = triangleGlb();
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
  json.buffers[0].uri = 'geometry/tree.bin';
  const bin = [...glb.subarray(28 + jsonLength)];
  const drop = () =>
    page.locator('#foliage-drop').evaluate(
      (element, { json, bin }) => {
        const source = new File([JSON.stringify(json)], 'tree.gltf');
        const buffer = new File([new Uint8Array(bin)], 'tree.bin');
        const file = (value) => ({
          name: value.name,
          isFile: true,
          isDirectory: false,
          file: (resolve) => resolve(value),
        });
        const directory = (name, children) => ({
          name,
          isFile: false,
          isDirectory: true,
          createReader: () => {
            let read = false;
            return {
              readEntries: (resolve) => {
                resolve(read ? [] : children);
                read = true;
              },
            };
          },
        });
        const entry = directory('tree.gltf', [
          file(source),
          directory('geometry', [file(buffer)]),
        ]);
        const data = new DataTransfer();
        data.items.add(source);
        // Synthetic drops cannot carry native directory entries. Patch the
        // provider while the production handler captures those entries.
        const getEntry = DataTransferItem.prototype.webkitGetAsEntry;
        DataTransferItem.prototype.webkitGetAsEntry = () => entry;
        try {
          element.dispatchEvent(
            new DragEvent('drop', {
              dataTransfer: data,
              bubbles: true,
              cancelable: true,
            }),
          );
        } finally {
          DataTransferItem.prototype.webkitGetAsEntry = getEntry;
        }
      },
      { json, bin },
    );
  await drop();
  await expect(page.locator('.import-status')).toContainText('1 model ready', {
    timeout: 30000,
  });
  await page.locator('.import-cancel').click();
  const before = await save(page, info, 'cancelled');
  expect(Object.keys(before.assets)).toHaveLength(0);
  await (await inspectorControl(page, '#import-foliage')).click();
  await drop();
  await expect(page.locator('.import-status')).toContainText('1 model ready', {
    timeout: 30000,
  });
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0, {
    timeout: 30000,
  });
  const imported = await save(page, info, 'imported');
  expect(Object.keys(imported.assets)).toHaveLength(1);
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 30000,
  });
  expect(await save(page, info, 'undone')).toEqual(before);
  expect(errors).toEqual([]);
});

test('artist glTF folder previews, embeds exact geometry and textures, and reloads from autosave', async ({
  page,
}, info) => {
  const folder = process.env.TERRAIN_TEST_GLTF_FOLDER;
  test.skip(
    !folder,
    'Set TERRAIN_TEST_GLTF_FOLDER to an extracted glTF package.',
  );
  test.setTimeout(360000);
  const name = basename(folder);
  const sourcePath = join(folder, name);
  const original = JSON.parse(await readFile(sourcePath, 'utf8'));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await page.locator('#foliage-files').setInputFiles(sourcePath);
  await expect(page.locator('.import-status')).toContainText(
    'Missing dependency',
  );
  await expect(page.locator('#foliage-locate-folder')).toBeVisible();
  const started = Date.now();
  await page.locator('#foliage-folder').setInputFiles(folder);
  await expect(page.locator('.import-status')).toContainText('1 model ready', {
    timeout: 180000,
  });
  const previewMs = Date.now() - started;
  const review = await page.locator('#foliage-model-review').textContent();
  const gpu = await page.locator('#fps').getAttribute('title');
  expect(gpu).toContain('WebGPU');
  expect(gpu).toMatch(/nvidia|blackwell|5060/i);
  await page.screenshot({ path: info.outputPath('artist-gltf-preview.png') });
  await page.locator('#foliage-import-profile').selectOption('tree');
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0, {
    timeout: 180000,
  });
  const project = await save(page, info, 'artist-gltf');
  const data = Object.values(project.assets)[0].data;
  const glb = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  const length = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + length));
  expect(json.meshes).toEqual(original.meshes);
  expect(json.accessors).toEqual(original.accessors);
  expect(json.bufferViews).toEqual(original.bufferViews);
  expect(json.buffers[0].uri).toBeUndefined();
  const originalBin = await readFile(join(folder, original.buffers[0].uri));
  expect(
    hash(glb.subarray(28 + length, 28 + length + originalBin.length)),
  ).toBe(hash(originalBin));
  for (let i = 0; i < original.images.length; i++) {
    const image = await readFile(join(folder, original.images[i].uri));
    expect(hash(Buffer.from(json.images[i].uri.split(',')[1], 'base64'))).toBe(
      hash(image),
    );
  }
  await expect(page.locator('#save-state')).toHaveText('Saved locally', {
    timeout: 120000,
  });
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(project.name, {
    timeout: 120000,
  });
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 120000,
  });
  const restored = await save(page, info, 'artist-reloaded');
  expect(Object.values(restored.assets)[0].data === data).toBe(true);
  await writeFile(
    info.outputPath('artist-gltf-report.json'),
    JSON.stringify(
      {
        source: name,
        binBytes: originalBin.length,
        preparedBytes: glb.length,
        imageCount: json.images.length,
        previewMs,
        review,
        gpu,
        binaryPreserved: true,
        texturesPreserved: true,
        autosaveReload: true,
        errors,
        scope:
          'One artist-owned model import, preview and persistence. Dense foliage performance is not measured.',
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
});
