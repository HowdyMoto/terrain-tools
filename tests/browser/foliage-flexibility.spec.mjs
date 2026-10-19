import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProject,
  editFoliageModels,
  serializeProject,
} from 'terrain-tools';
import { maskedPlantGlb, decodeDocument } from './fixtures.mjs';
async function save(page, selector, path) {
  const pending = page.waitForEvent('download');
  await (await inspectorControl(page, selector)).click();
  await (await pending).saveAs(path);
  return readFile(path);
}
async function number(page, key, value) {
  await (
    await inspectorControl(page, '#flexibility-' + key)
  ).fill(String(value));
  await (await inspectorControl(page, '#flexibility-' + key)).press('Tab');
}
test('authors plant masks with undo, validation, autosave, portable brushes, and GLB/runtime round trips', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120000);
  const errors = [];
  const capture = (target) => {
    target.on('pageerror', (error) => errors.push(error.message));
    target.on('console', (message) => {
      if (
        message.type() === 'error' &&
        /THREE|Shader|WebGL/.test(message.text())
      )
        errors.push(message.text());
    });
  };
  capture(page);
  const project = createProject(32, 64);
  project.name = 'Plant flexibility';
  project.heights.fill(0);
  project.foliage = [];
  project.props = [];
  project.view.water = false;
  project.assets = {
    plant: {
      name: 'Painted plant.glb',
      data:
        'data:model/gltf-binary;base64,' + maskedPlantGlb().toString('base64'),
    },
  };
  const model = editFoliageModels(project.brushes[0], [])[0];
  Object.assign(model, {
    model: 'plant',
    wind: 1,
    crush: 1,
    alignToNormal: false,
  });
  project.foliage = [1, 2, 3].map((id, i) => ({
    id,
    brushId: project.brushes[0].id,
    modelId: model.id,
    x: (i - 1) * 8,
    z: 0,
    scale: 2,
    rotation: 0,
  }));
  project.nextId = 4;
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await page.locator('#file-open').setInputFiles({
    name: 'mask-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await page.locator('[data-tab=foliage]').click();
  await expect(page.locator('#flexibility-source')).toHaveValue('whole');
  await (
    await inspectorControl(page, '#flexibility-source')
  ).selectOption('height');
  await number(page, 'start', 0.2);
  await number(page, 'end', 0.9);
  await number(page, 'exponent', 2.5);
  await (
    await inspectorControl(page, '#flexibility-source')
  ).selectOption('attribute');
  await expect(page.locator('#flexibility-availability')).toContainText(
    'Primary: 1 of 2 mesh parts',
  );
  await page.locator('#undo').click();
  await expect(page.locator('#flexibility-source')).toHaveValue('height');
  await page.locator('#redo').click();
  await expect(page.locator('#flexibility-source')).toHaveValue('attribute');
  await number(page, 'start', 0.95);
  await expect(page.locator('#toast')).toContainText(
    'must exceed the rigid threshold',
  );
  await expect(page.locator('#flexibility-start')).toHaveValue('0.2');
  await (
    await inspectorControl(page, '#flexibility-source')
  ).selectOption('alpha');
  await expect(page.locator('#flexibility-availability')).toContainText(
    'Primary: 0 of 2 mesh parts',
  );
  await page.locator('#undo').click();
  await expect(page.locator('#flexibility-source')).toHaveValue('attribute');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const expected = { source: 'attribute', start: 0.2, end: 0.9, exponent: 2.5 };
  const nativePath = testInfo.outputPath('masked.terrain');
  const authored = decodeDocument(await save(page, '#save', nativePath));
  expect(authored.brushes[0].models[0].flexibility).toEqual(expected);
  const brushPath = testInfo.outputPath('masked.foliage.json');
  const preset = decodeDocument(await save(page, '#save-brush', brushPath));
  expect(preset.brush.models[0].flexibility).toEqual(expected);
  await page.reload();
  await expect(page.locator('#foliage-count')).toHaveText('3', {
    timeout: 30000,
  });
  await page.locator('[data-tab=foliage]').click();
  await expect(page.locator('#flexibility-source')).toHaveValue('attribute');
  await expect(page.locator('#flexibility-exponent')).toHaveValue('2.5');
  await (
    await inspectorControl(page, '.foliage-flexibility-controls')
  ).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('foliage-flexibility-editor.png'),
  });
  const glbPath = testInfo.outputPath('masked.glb');
  const glb = await save(page, '#export', glbPath);
  expect(decodeDocument(glb)).toEqual(authored);
  const presentation = JSON.parse(
    glb.subarray(20, 20 + glb.readUInt32LE(12)).toString(),
  );
  for (const mesh of presentation.meshes)
    for (const primitive of mesh.primitives) {
      expect(primitive.attributes).not.toHaveProperty('_TERRAINCONTACT');
      expect(primitive.attributes).not.toHaveProperty('_TERRAINFLEXIBILITY');
    }
  await page.locator('#file-open').setInputFiles(glbPath);
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await expect(page.locator('#flexibility-source')).toHaveValue('attribute');
  await page.locator('#brush-open').setInputFiles(brushPath);
  await expect(page.locator('#toast')).toContainText('Brush imported');
  await expect(page.locator('#flexibility-exponent')).toHaveValue('2.5');
  const runtime = await context.newPage();
  capture(runtime);
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances', {
    timeout: 30000,
  });
  await runtime.locator('#open-project').setInputFiles(glbPath);
  await expect(runtime.locator('#status')).toContainText('3 foliage instances');
  await runtime.locator('#contact').click();
  await runtime.close();
  expect(errors).toEqual([]);
});
