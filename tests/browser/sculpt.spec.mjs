import { inspectorControl } from './inspector-controls.mjs';
import { decodeDocument } from './fixtures.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const fixtures = decodeDocument(
  await readFile(
    new URL('../fixtures/heightmaps.json', import.meta.url),
    'utf8',
  ),
);
async function range(page, id, value) {
  await page.locator('#' + id).evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function number(page, id, value) {
  await (await inspectorControl(page, '#' + id)).fill(String(value));
  await (await inspectorControl(page, '#' + id)).press('Tab');
}
async function download(page, button, path) {
  const pending = page.waitForEvent('download');
  await (await inspectorControl(page, button)).click();
  await (await pending).saveAs(path);
  return readFile(path);
}
async function save(page, name) {
  return decodeDocument(
    await download(page, '#save', 'test-results/' + name + '.json'),
  );
}
test('sculpts alpha stamps, restores undo, and preserves precise heightmaps through PNG16, RAW16 and GLB', async ({
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
  await (await inspectorControl(page, '#preset')).selectOption('flat');
  await (await inspectorControl(page, '#resolution')).selectOption('64');
  await (await inspectorControl(page, '#generate')).click();
  await expect(page.locator('#toast')).toContainText('Landscape generated');
  await page.locator('#water-toggle').click();
  await (await inspectorControl(page, '#alpha-kind')).selectOption('ridge');
  await range(page, 'stamp-height', 20);
  await range(page, 'radius', 24);
  await range(page, 'alpha-rotation', 45);
  await (await inspectorControl(page, '[data-tool="stamp"]')).click();
  const box = await page
    .getByLabel('Interactive terrain viewport')
    .boundingBox();
  const point = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.57 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  // Holding the stamp must not accumulate repeated applications.
  await page.waitForTimeout(400);
  await page.mouse.up();
  const stamped = await save(page, 'stamp-once');
  expect(Math.max(...stamped.heights)).toBeGreaterThan(3);
  expect(Math.max(...stamped.heights)).toBeLessThanOrEqual(20.001);
  await page.locator('#undo').click();
  expect((await save(page, 'stamp-undone')).heights.every((h) => h === 0)).toBe(
    true,
  );
  await page.locator('#redo').click();
  expect((await save(page, 'stamp-redone')).heights).toEqual(stamped.heights);
  await page.screenshot({ path: 'test-results/sculpt-stamp.png' });

  await page.locator('#alpha-open').setInputFiles({
    name: 'Precise alpha.png',
    mimeType: 'image/png',
    buffer: Buffer.from(fixtures.filters, 'base64'),
  });
  await expect(page.locator('#toast')).toContainText('Alpha imported: 3 × 5');
  await range(page, 'alpha-rotation', 90);
  await (await inspectorControl(page, '#stamp-mode')).selectOption('set');
  await range(page, 'stamp-base', -4);
  const beforeEntry = await save(page, 'stamp-before-entry');
  expect(beforeEntry.sculpt.alpha.values[1]).toBeGreaterThan(0);
  expect(beforeEntry.sculpt.alpha.values[1]).toBeLessThan(1 / 255);
  // Start over sky, then enter terrain: the first actual hit must own an undo checkpoint.
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.08);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 10 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  expect((await save(page, 'stamp-after-entry')).heights).not.toEqual(
    beforeEntry.heights,
  );
  await page.locator('#undo').click();
  expect((await save(page, 'stamp-entry-undone')).heights).toEqual(
    beforeEntry.heights,
  );

  await (await inspectorControl(page, '[data-tool="hole"]')).click();
  await page.mouse.click(point.x, point.y);
  const withHole = await save(page, 'stamp-hole');
  expect(withHole.holes.some(Boolean)).toBe(true);
  await number(page, 'heightmap-min', -10);
  await number(page, 'heightmap-max', 30);
  await page.locator('#heightmap-open').setInputFiles({
    name: 'Elevation.png',
    mimeType: 'image/png',
    buffer: Buffer.from(fixtures.filters, 'base64'),
  });
  await expect(page.locator('#toast')).toContainText('resampled to 65 × 65');
  const imported = await save(page, 'heightmap-imported');
  expect(imported.heights[0]).toBe(-10);
  expect(imported.heights[16 * 65]).toBeCloseTo(30, 4);
  expect(imported.heights[64]).toBeCloseTo(-10 + (40 * 256) / 65535, 4);
  expect(imported.holes).toEqual(withHole.holes);
  expect(imported.sculpt).toEqual(withHole.sculpt);
  const png = await download(
    page,
    '#export-heightmap',
    'test-results/elevation-16.png',
  );
  expect(png[24]).toBe(16);
  expect(png[25]).toBe(0);
  await (await inspectorControl(page, '[data-tool="raise"]')).click();
  await page.mouse.click(point.x, point.y);
  await page
    .locator('#heightmap-open')
    .setInputFiles('test-results/elevation-16.png');
  await expect(page.locator('#toast')).toContainText('Heightmap imported');
  const restored = await save(page, 'heightmap-restored');
  for (let i = 0; i < restored.heights.length; i++)
    expect(Math.abs(restored.heights[i] - imported.heights[i])).toBeLessThan(
      40 / 65535 / 2 + 0.00001,
    );
  expect(restored.holes).toEqual(imported.holes);

  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByText('RAW16 options', { exact: true }).click();
  await number(page, 'raw-width', 65);
  await number(page, 'raw-height', 65);
  await (await inspectorControl(page, '#raw-order')).selectOption('be');
  const raw = await download(page, '#export-raw', 'test-results/elevation.r16');
  expect(raw.length).toBe(65 * 65 * 2);
  await page
    .locator('#heightmap-open')
    .setInputFiles('test-results/elevation.r16');
  await expect(page.locator('#toast')).toContainText('Heightmap imported');
  const rawRestored = await save(page, 'heightmap-raw-restored');
  expect(rawRestored.heights).toEqual(restored.heights);
  await page.locator('#heightmap-open').setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('invalid'),
  });
  await expect(page.locator('#toast')).toContainText(
    'Could not import heightmap',
  );
  expect((await save(page, 'heightmap-after-invalid')).heights).toEqual(
    rawRestored.heights,
  );

  const glb = await download(page, '#export', 'test-results/stamped-scene.glb');
  const doc = decodeDocument(
    glb.subarray(20, 20 + glb.readUInt32LE(12)).toString(),
  );
  expect(decodeDocument(glb).sculpt).toEqual(rawRestored.sculpt);
  await page
    .locator('#file-open')
    .setInputFiles('test-results/stamped-scene.glb');
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  expect((await save(page, 'stamp-glb-reopened')).sculpt).toEqual(
    rawRestored.sculpt,
  );
  await page.screenshot({ path: 'test-results/heightmap-editor.png' });
  expect(errors).toEqual([]);
});
