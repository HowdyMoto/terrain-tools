import { inspectorControl } from './inspector-controls.mjs';
import { decodeDocument, loadProceduralProject } from './fixtures.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { triangleGlb } from './fixtures.mjs';

async function range(page, id, value) {
  await page.locator('#' + id).evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function download(page, button, path) {
  const pending = page.waitForEvent('download');
  await (await inspectorControl(page, button)).click();
  await (await pending).saveAs(path);
  return readFile(path);
}

test('authors, paints, populates, exports and reuses a multi-model foliage brush', async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /THREE|Shader|WebGL/i.test(m.text()))
      errors.push(m.text());
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await loadProceduralProject(page);
  await (await inspectorControl(page, '#preset')).selectOption('flat');
  await (await inspectorControl(page, '#resolution')).selectOption('32');
  await (await inspectorControl(page, '#generate')).click();
  await expect(page.locator('#toast')).toContainText('Landscape generated');
  await page.locator('[data-tab="water"]').click();
  await page
    .getByRole('checkbox', { name: 'Show ocean', exact: true })
    .uncheck();
  await expect(page.locator('#water')).not.toBeChecked();
  await page.locator('[data-tab="foliage"]').click();
  await (await inspectorControl(page, '#brush-name')).fill('Forest edge');
  await (await inspectorControl(page, '#brush-name')).press('Tab');
  await range(page, 'model-weight', 3);
  await range(page, 'min-scale', 1);
  await range(page, 'max-scale', 1.8);
  await range(page, 'min-rotation', -60);
  await range(page, 'max-rotation', -30);
  await range(page, 'brush-crush', 0);
  await (await inspectorControl(page, '#add-model')).click();
  await expect(page.locator('#model-entry option')).toHaveCount(2);
  await range(page, 'model-weight', 1);
  await range(page, 'min-scale', 0.3);
  await range(page, 'max-scale', 0.7);
  await range(page, 'max-rotation', 80);
  await range(page, 'min-rotation', 40);
  await range(page, 'brush-wind', 1.5);
  await (await inspectorControl(page, '#add-model')).click();
  await page.locator('#asset-open').setInputFiles({
    name: 'Marker.glb',
    mimeType: 'model/gltf-binary',
    buffer: triangleGlb(),
  });
  await expect(page.locator('#toast')).toHaveText('Model imported.');
  await range(page, 'model-weight', 1);
  await range(page, 'density', 0.2);
  await range(page, 'foliage-spacing', 3);
  for (const checkbox of await page.locator('[data-allowed]').all())
    await (await inspectorControl(page, checkbox)).check();
  await (await inspectorControl(page, '#model-entry')).selectOption('1');
  await expect(page.locator('#min-scale')).toHaveValue('0.3');
  await expect(page.locator('#max-scale')).toHaveValue('0.7');
  // A real pointer stroke uses the configured mixture before any population command.
  const box = await page
    .getByLabel('Interactive terrain viewport')
    .boundingBox();
  await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.57);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.57, {
    steps: 8,
  });
  await page.mouse.up();
  const painted = decodeDocument(
    await download(page, '#save', 'test-results/mixed-painted.json'),
  );
  expect(new Set(painted.foliage.map((f) => f.modelId)).size).toBe(3);
  await (await inspectorControl(page, '#populate')).click();
  await expect(page.locator('#toast')).toContainText('instances placed');
  const populated = decodeDocument(
    await download(page, '#save', 'test-results/mixed-foliage.json'),
  );
  const brush = populated.brushes[0];
  expect(brush.models).toHaveLength(3);
  expect(populated.foliage.length).toBeGreaterThan(500);
  expect(new Set(populated.foliage.map((f) => f.modelId)).size).toBe(3);
  for (const f of populated.foliage) {
    const m = brush.models.find((m) => m.id === f.modelId);
    expect(f.scale).toBeGreaterThanOrEqual(m.minScale);
    expect(f.scale).toBeLessThanOrEqual(m.maxScale);
    expect((f.rotation * 180) / Math.PI).toBeGreaterThanOrEqual(m.minRotation);
    expect((f.rotation * 180) / Math.PI).toBeLessThanOrEqual(m.maxRotation);
  }
  await (await inspectorControl(page, '#model-entry')).selectOption('0');
  await range(page, 'model-weight', 0);
  const unchanged = decodeDocument(
    await download(page, '#save', 'test-results/mixed-weight.json'),
  );
  expect(unchanged.foliage).toEqual(populated.foliage);
  await range(page, 'model-weight', 3);
  // Removing a member removes its instances, and Undo restores both.
  await (await inspectorControl(page, '#model-entry')).selectOption('2');
  const removedId = brush.models[2].id;
  await (await inspectorControl(page, '#remove-model')).click();
  const removed = decodeDocument(
    await download(page, '#save', 'test-results/mixed-removed.json'),
  );
  expect(removed.foliage.some((f) => f.modelId === removedId)).toBe(false);
  await page.locator('#undo').click();
  await expect(page.locator('#model-entry option')).toHaveCount(3);
  const restored = decodeDocument(
    await download(page, '#save', 'test-results/mixed-restored.json'),
  );
  expect(restored.foliage).toEqual(populated.foliage);
  const preset = decodeDocument(
    await download(
      page,
      '#save-brush',
      'test-results/forest-edge.foliage.json',
    ),
  );
  expect(Object.keys(preset.assets)).toHaveLength(1);
  await page
    .locator('#brush-open')
    .setInputFiles('test-results/forest-edge.foliage.json');
  await expect(page.locator('#toast')).toContainText('Brush imported');
  await expect(page.locator('#brush-select option')).toHaveCount(3);
  const reused = decodeDocument(
    await download(page, '#save', 'test-results/mixed-reused.json'),
  );
  expect(reused.brushes[2].models).toEqual(brush.models);
  expect(Object.keys(reused.assets)).toHaveLength(1);
  await (await inspectorControl(page, '#model-entry')).selectOption('1');
  await page.screenshot({ path: 'test-results/mixed-foliage.png' });
  const glb = await download(page, '#export', 'test-results/mixed-foliage.glb');
  const document = decodeDocument(
    glb.subarray(20, 20 + glb.readUInt32LE(12)).toString(),
  );
  expect(decodeDocument(glb)).toEqual(reused);
  const instanced = document.nodes.filter(
    (n) => n.extensions?.EXT_mesh_gpu_instancing,
  );
  expect(new Set(instanced.map((n) => n.extras.model)).size).toBe(3);
  await page
    .locator('#file-open')
    .setInputFiles('test-results/mixed-foliage.glb');
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  expect(
    decodeDocument(
      await download(page, '#save', 'test-results/mixed-reopened.json'),
    ),
  ).toEqual(reused);
  // Brush load failure leaves the valid editor state intact.
  await page.locator('#brush-open').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"kind":"wrong"}'),
  });
  await expect(page.locator('#toast')).toContainText('Could not import brush');
  expect(
    decodeDocument(
      await download(page, '#save', 'test-results/mixed-after-invalid.json'),
    ),
  ).toEqual(reused);
  const runtime = await context.newPage();
  runtime.on('pageerror', (e) => errors.push(e.message));
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances', {
    timeout: 30000,
  });
  await runtime
    .locator('#open-project')
    .setInputFiles('test-results/mixed-foliage.glb');
  await expect(runtime.locator('#status')).toContainText(
    reused.foliage.length.toLocaleString(),
  );
  await runtime.locator('#contact').click();
  await runtime.screenshot({ path: 'test-results/mixed-runtime.png' });
  await runtime.close();
  expect(errors).toEqual([]);
});
