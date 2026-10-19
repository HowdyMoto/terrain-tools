import { inspectorControl } from './inspector-controls.mjs';
import { decodeDocument } from './fixtures.mjs';
import { triangleGlb } from './fixtures.mjs';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
test('renders and edits terrain, saves a recoverable project, and initializes collision', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (
      m.type() === 'error' &&
      /THREE|Shader|WebGL|initialization/i.test(m.text())
    )
      errors.push(m.text());
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await expect(
    page.getByRole('heading', { name: 'Sculpt', exact: true }),
  ).toBeVisible();
  await page.locator('#help').click();
  await expect(
    page.getByRole('heading', { name: 'Shape a world.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close guide' }).click();
  await page.locator('[data-tab="materials"]').click();
  await page.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(
    page.getByText('Automatic placement', { exact: true }),
  ).toBeVisible();
  await (await inspectorControl(page, '#mat-name')).fill('Test meadow');
  await (await inspectorControl(page, '#mat-name')).press('Tab');
  await expect(page.locator('#layer-list')).toContainText('Test meadow');
  await page.locator('[data-tab="sculpt"]').click();
  const canvas = page.getByLabel('Interactive terrain viewport');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await expect(page.locator('#undo')).toBeEnabled();
  await (await inspectorControl(page, '[data-tool="hole"]')).click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const download = await pending;
  await download.saveAs('test-results/smoke.terrain.json');
  const saved = decodeDocument(
    await readFile('test-results/smoke.terrain.json'),
  );
  expect(saved.materials[0].name).toBe('Test meadow');
  expect(saved.holes.some((cell) => cell === 1)).toBe(true);
  await page.locator('[data-tab="foliage"]').click();
  await expect(
    page.getByText('Allowed surfaces', { exact: true }),
  ).toBeVisible();
  await (await inspectorControl(page, '#brush-select')).selectOption('1');
  await (await inspectorControl(page, '#populate')).click();
  await expect(page.locator('#toast')).toContainText('instances placed');
  await page.locator('[data-tab="light"]').click();
  await page.getByRole('tab', { name: 'View', exact: true }).click();
  await page.getByText('Flat / low-poly shading', { exact: true }).click();
  await expect(page.locator('#low-poly')).toBeChecked();
  await expect(page.locator('#shading-label')).toHaveText('Flat');
  await page.locator('#physics').click();
  await expect(page.locator('#physics-state')).toHaveText(
    'Terrain collision active',
    { timeout: 30000 },
  );
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.locator('[data-tab="sculpt"]').click();
  await expect(page.locator('[data-tab="sculpt"]')).toHaveClass(/active/);
  await expect(page.locator('[data-tab="light"]')).not.toHaveClass(/active/);
  await page.screenshot({ path: 'test-results/editor.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('imports an embedded GLB, places a cutout prop, restores it, and rejects a malformed project', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await page.locator('[data-tab="props"]').click();
  await page.locator('#asset-open').setInputFiles({
    name: 'Test marker.glb',
    mimeType: 'model/gltf-binary',
    buffer: triangleGlb(),
  });
  await expect(page.locator('#toast')).toHaveText('Model imported.');
  await page.getByText('Cut terrain below prop', { exact: true }).click();
  const box = await page
    .getByLabel('Interactive terrain viewport')
    .boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.58);
  await expect(page.locator('#prop-list')).toContainText('Test marker.glb');
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const download = await pending;
  await download.saveAs('test-results/asset.terrain.json');
  const saved = decodeDocument(
    await readFile('test-results/asset.terrain.json'),
  );
  expect(saved.props).toHaveLength(1);
  expect(saved.props[0].cutHole).toBe(true);
  expect(saved.assets[saved.props[0].model]).toEqual({
    name: 'Test marker.glb',
    data: 'data:model/gltf-binary;base64,' + triangleGlb().toString('base64'),
  });
  await (await inspectorControl(page, '#delete-prop')).click();
  await expect(page.locator('#prop-list')).toHaveText('');
  await page
    .locator('#file-open')
    .setInputFiles('test-results/asset.terrain.json');
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await expect(page.locator('#prop-list')).toContainText('Test marker.glb');
  await page.locator('#file-open').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":99}'),
  });
  await expect(page.locator('#toast')).toContainText('Could not open project');
  await expect(page.locator('#prop-list')).toContainText('Test marker.glb');
});
