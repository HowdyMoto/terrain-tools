import { inspectorControl } from './inspector-controls.mjs';
import { decodeDocument, loadProceduralProject } from './fixtures.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { triangleGlb } from './fixtures.mjs';
async function number(page, id, value) {
  await (await inspectorControl(page, '#' + id)).fill(String(value));
  await (await inspectorControl(page, '#' + id)).press('Tab');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
}
async function save(page, button, name) {
  const pending = page.waitForEvent('download');
  await (await inspectorControl(page, button)).click();
  const path = 'test-results/' + name;
  await (await pending).saveAs(path);
  return readFile(path);
}
test('authors distance LODs, restores hidden plants, and exports complete primary geometry with portable LOD assets', async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
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
  await page.locator('[data-tab=foliage]').click();
  const before = decodeDocument(await save(page, '#save', 'lod-original.json'));
  const count = before.foliage.length;
  await expect(page.locator('#foliage-detail-stats')).toContainText(
    count.toLocaleString() + ' plants selected',
  );
  const fullTriangles = Number(
    (await page.locator('#foliage-detail-stats').textContent())
      .split(' · ')[2]
      .split(' foliage')[0]
      .replaceAll(',', ''),
  );
  await expect(page.locator('#foliage-lod-fade')).toHaveValue('0');
  await (await inspectorControl(page, '#add-lod')).click();
  await expect(page.locator('#foliage-lod-fade')).toHaveValue('0.25');
  await number(page, 'foliage-lod-fade', 0.4);
  await number(page, 'foliage-lod-fade', 6);
  await expect(page.locator('#foliage-lod-fade')).toHaveValue('0.4');
  await (await inspectorControl(page, '#lod-model-0')).selectOption('pine-low');
  await number(page, 'lod-distance-0', 1);
  await expect(page.locator('#foliage-detail-stats')).toContainText(
    count.toLocaleString() + ' plants selected',
  );
  await expect
    .poll(async () => {
      const text = await page.locator('#foliage-detail-stats').textContent();
      return Number(
        text.split(' · ')[2].split(' foliage')[0].replaceAll(',', ''),
      );
    })
    .toBeLessThan(fullTriangles / 2);
  await number(page, 'lod-density-0', 40);
  await expect
    .poll(async () =>
      Number(
        (await page.locator('#foliage-detail-stats').textContent())
          .split(' plants')[0]
          .replaceAll(',', ''),
      ),
    )
    .toBeLessThan(count * 0.6);
  await (await inspectorControl(page, '#add-lod')).click();
  await number(page, 'lod-distance-1', 2);
  await number(page, 'lod-density-1', 20);
  const chooser = page.waitForEvent('filechooser');
  await (await inspectorControl(page, '[data-import-lod="1"]')).click();
  await (
    await chooser
  ).setFiles({
    name: 'Distant marker.glb',
    mimeType: 'model/gltf-binary',
    buffer: triangleGlb(),
  });
  await expect(page.locator('#toast')).toHaveText('Model imported.');
  await number(page, 'foliage-cull-distance', 3);
  await expect(page.locator('#foliage-detail-stats')).toContainText(
    '0 plants selected',
  );
  const culled = decodeDocument(await save(page, '#save', 'lod-culled.json'));
  expect(culled.foliage).toEqual(
    before.foliage.map((instance) => ({
      ...instance,
      modelId: instance.modelId ?? 'primary',
    })),
  ); // Editing promotes legacy single-model entries.
  expect(culled.brushes[0].models[0].model).toBe('pine');
  expect(culled.brushes[0].models[0].lodFadeDuration).toBe(0.4);
  const lod = culled.brushes[0].models[0].lods[1];
  expect(culled.assets[lod.model].name).toBe('Distant marker.glb');
  await number(page, 'foliage-cull-distance', 1); // Invalid: does not exceed LOD2.
  await expect(page.locator('#toast')).toContainText('Cull distance must');
  await expect(page.locator('#foliage-cull-distance')).toHaveValue('3');
  const preset = decodeDocument(
    await save(page, '#save-brush', 'lod-brush.foliage.json'),
  );
  expect(Object.keys(preset.assets)).toEqual([lod.model]);
  await page.locator('#undo').click(); // Invalid input adds no history; undo the valid cull setting.
  await expect(page.locator('#foliage-cull-distance')).toHaveValue('0');
  await expect
    .poll(async () =>
      Number(
        (await page.locator('#foliage-detail-stats').textContent())
          .split(' plants')[0]
          .replaceAll(',', ''),
      ),
    )
    .toBeGreaterThan(0);
  await page.locator('#redo').click();
  await expect(page.locator('#foliage-detail-stats')).toContainText(
    '0 plants selected',
  );
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await page.locator('[data-tab=foliage]').click();
  await expect(page.locator('#foliage-cull-distance')).toHaveValue('3');
  await expect(page.locator('#foliage-detail-stats')).toContainText(
    '0 plants selected',
  );
  const glb = await save(page, '#export', 'lod-scene.glb');
  const json = decodeDocument(
    glb.subarray(20, 20 + glb.readUInt32LE(12)).toString(),
  );
  const instanced = json.nodes.filter(
    (n) => n.extensions?.EXT_mesh_gpu_instancing,
  );
  expect(new Set(instanced.map((n) => n.extras.model))).toEqual(
    new Set(['pine']),
  );
  const exportedCount = instanced.reduce(
    (sum, node) =>
      sum +
      json.accessors[
        node.extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION
      ].count,
    0,
  );
  expect(exportedCount).toBe(count * 2); // Trunk and crown parts, each complete.
  expect(decodeDocument(glb)).toEqual(culled);
  await page.locator('#file-open').setInputFiles('test-results/lod-scene.glb');
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  expect(
    decodeDocument(await save(page, '#save', 'lod-reopened.json')),
  ).toEqual(culled);
  await number(page, 'foliage-cull-distance', 0);
  await (await inspectorControl(page, '[data-remove-lod="1"]')).click();
  await number(page, 'lod-density-0', 100);
  await (await inspectorControl(page, '#lod-model-0')).scrollIntoViewIfNeeded();
  await expect(page.locator('#foliage-detail-stats')).toContainText(
    count.toLocaleString() + ' plants selected',
  );
  await page.screenshot({ path: 'test-results/foliage-lod-editor.png' });
  const runtime = await context.newPage();
  runtime.on('pageerror', (e) => errors.push(e.message));
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances', {
    timeout: 30000,
  });
  await runtime
    .locator('#open-project')
    .setInputFiles('test-results/lod-scene.glb');
  await expect(runtime.locator('#foliage-rendering')).toContainText(
    '0 plants selected',
  );
  await runtime.close();
  expect(errors).toEqual([]);
});
