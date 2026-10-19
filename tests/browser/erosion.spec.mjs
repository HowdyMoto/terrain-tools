import { inspectorControl } from './inspector-controls.mjs';
import { decodeDocument } from './fixtures.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function save(page, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = 'test-results/' + name + '.json';
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
test('previews, compares, cancels and applies erosion as one undoable terrain change', async ({
  page,
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
  const box = await page
    .getByLabel('Interactive terrain viewport')
    .boundingBox();
  const point = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.6 };
  await (await inspectorControl(page, '[data-tool="hole"]')).click();
  await page.mouse.click(point.x, point.y);
  const initial = await save(page, 'erosion-original');
  expect(initial.holes.some(Boolean)).toBe(true);
  await (await inspectorControl(page, '#weather-landscape')).click();
  const panel = page.locator('#erosion-dialog');
  await expect(panel).toBeVisible();
  await panel.locator('[name=rainfall]').fill('4');
  await panel.locator('[name=maxDepth]').fill('8');
  await panel.locator('#erosion-preview').click();
  await expect(panel.locator('#erosion-status')).toContainText(
    'Preview ready',
    { timeout: 45000 },
  );
  await expect(panel.locator('#erosion-apply')).toBeEnabled();
  await page.screenshot({ path: 'test-results/erosion-preview.png' });
  await panel.locator('#erosion-original').click();
  await expect(panel.locator('#erosion-original')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({ path: 'test-results/erosion-before.png' });
  await panel.locator('#erosion-result').click();
  // The visible preview cannot be sculpted or inserted into undo by a shortcut.
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press('Control+z');
  await expect(panel).toBeVisible();
  await panel.locator('#erosion-cancel').click();
  expect(await save(page, 'erosion-cancelled')).toEqual(initial);

  await (await inspectorControl(page, '#weather-landscape')).click();
  await panel.locator('[name=rainfall]').fill('4');
  await panel.locator('[name=maxDepth]').fill('8');
  await panel.locator('#erosion-preview').click();
  await expect(panel.locator('#erosion-status')).toContainText(
    'Preview ready',
    { timeout: 45000 },
  );
  // Editing a setting invalidates the rendered result and disables Apply.
  await panel.locator('[name=talus]').fill('30');
  await expect(panel.locator('#erosion-apply')).toBeDisabled();
  await panel.locator('#erosion-preview').click();
  await expect(panel.locator('#erosion-status')).toContainText(
    'Preview ready',
    { timeout: 45000 },
  );
  await panel.locator('#erosion-apply').click();
  await expect(panel).not.toBeAttached();
  await expect(page.locator('#toast')).toContainText('Erosion applied');
  const after = await save(page, 'erosion-applied');
  expect(after.heights).not.toEqual(initial.heights);
  expect(after.erosion).toMatchObject({
    mode: 'both',
    rainfall: 4,
    maxDepth: 8,
    talus: 30,
  });
  for (const key of [
    'holes',
    'paint',
    'foliage',
    'props',
    'materials',
    'assets',
  ])
    expect(after[key]).toEqual(initial[key]);
  await page.locator('#undo').click();
  expect(await save(page, 'erosion-undone')).toEqual(initial);
  await page.locator('#redo').click();
  expect(await save(page, 'erosion-redone')).toEqual(after);
  await page.reload();
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  expect(await save(page, 'erosion-reloaded')).toEqual(after);
  await (await inspectorControl(page, '#weather-landscape')).click();
  await expect(panel.locator('[name=talus]')).toHaveValue('30');
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeAttached();
  const exported = page.waitForEvent('download');
  await page.locator('#export').click();
  await (await exported).saveAs('test-results/eroded-scene.glb');
  const bytes = await readFile('test-results/eroded-scene.glb');
  const embedded = decodeDocument(bytes);
  expect(embedded.erosion).toEqual(after.erosion);
  expect(embedded.heights).toEqual(after.heights);
  await page
    .locator('#file-open')
    .setInputFiles('test-results/eroded-scene.glb');
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  expect(await save(page, 'erosion-glb-reopened')).toEqual(after);
  expect(errors).toEqual([]);
});

test('cancels a live large-grid worker without changing terrain or leaving controls locked', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await (await inspectorControl(page, '#resolution')).selectOption('512');
  await (await inspectorControl(page, '#generate')).click();
  await expect(page.locator('#toast')).toContainText('Landscape generated', {
    timeout: 30000,
  });
  const before = await save(page, 'erosion-large-before');
  await (await inspectorControl(page, '#weather-landscape')).click();
  const panel = page.locator('#erosion-dialog');
  await panel.locator('[name=rainfall]').fill('8');
  await panel.locator('[name=radius]').fill('6');
  await panel.locator('summary').click();
  await panel.locator('[name=maxSteps]').fill('128');
  await panel.locator('#erosion-preview').click();
  await expect(panel.locator('#erosion-preview')).toBeDisabled();
  await expect(panel.locator('#erosion-status')).toContainText(
    /Calculating|Carving/,
  );
  await panel.locator('#erosion-cancel').click();
  await expect(panel).not.toBeAttached();
  expect(await save(page, 'erosion-large-cancelled')).toEqual(before);
  await (await inspectorControl(page, '#weather-landscape')).click();
  await panel.locator('[name=mode]').selectOption('thermal');
  await panel.locator('[name=thermalIterations]').fill('1');
  await panel.locator('#erosion-preview').click();
  await expect(panel.locator('#erosion-status')).toContainText(
    'Preview ready',
    { timeout: 30000 },
  );
  await panel.locator('#erosion-cancel').click();
  expect(await save(page, 'erosion-large-retried')).toEqual(before);
});
