import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodeDocument } from './fixtures.mjs';

async function save(page, name) {
  const download = page.waitForEvent('download');
  await page.locator('#save').click();
  const file = 'test-results/' + name + '.terrain';
  await (await download).saveAs(file);
  const document = decodeDocument(await readFile(file));
  // Compare complete payloads without printing megabytes of base64 on failure.
  for (const asset of Object.values(document.assets))
    asset.data = createHash('sha256').update(asset.data).digest('hex');
  return document;
}
function errors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /THREE|Shader|WebGL/i.test(m.text()))
      errors.push(m.text());
  });
  return errors;
}
test('starts with four credited photoreal brushes, paints plants, and preserves embedded models through undo, portable brush save and reload', async ({
  page,
}) => {
  test.setTimeout(150000);
  const issues = errors(page);
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await page.locator('[data-tab=foliage]').click();
  await expect(page.locator('#brush-select option')).toHaveCount(4);
  await expect(page.locator('#brush-select option').first()).toHaveText(
    'Photoreal pine trees',
  );
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Asset credits' }),
  ).toHaveAttribute('href', '/foliage/photoreal/CREDITS.txt');
  await page.screenshot({ path: 'test-results/photoreal-defaults.png' });
  const defaults = await save(page, 'photoreal-defaults');
  expect(Object.keys(defaults.assets)).toHaveLength(15);
  expect(
    defaults.brushes[0].models.every((model) => !model.interaction.enabled),
  ).toBe(true);
  expect(
    defaults.brushes
      .slice(1)
      .every((brush) =>
        brush.models.every((model) => model.interaction.enabled),
      ),
  ).toBe(true);
  expect(
    defaults.brushes.every((b) =>
      b.models.every((m) => m.model.startsWith('ph-') && m.lods.length > 0),
    ),
  ).toBe(true);
  await page.locator('[data-tab=sculpt]').click();
  await (await inspectorControl(page, '#preset')).selectOption('flat');
  await (await inspectorControl(page, '#resolution')).selectOption('32');
  await (await inspectorControl(page, '#generate')).click();
  await expect(page.locator('#toast')).toContainText('Landscape generated');
  await page.locator('[data-tab=water]').click();
  await (await inspectorControl(page, '#water')).uncheck();
  await page.locator('[data-tab=foliage]').click();
  await (await inspectorControl(page, '#brush-select')).selectOption('1');
  for (const box of await page.locator('[data-allowed]').all())
    await (await inspectorControl(page, box)).check();
  const before = await save(page, 'photoreal-before-paint');
  const viewport = await page
    .getByLabel('Interactive terrain viewport')
    .boundingBox();
  await page.mouse.click(
    viewport.x + viewport.width * 0.5,
    viewport.y + viewport.height * 0.58,
  );
  await expect(page.locator('#foliage-count')).not.toHaveText('0');
  const painted = await save(page, 'photoreal-painted');
  expect(painted.foliage.length).toBeGreaterThan(0);
  expect(
    painted.foliage.every((f) => f.brushId === painted.brushes[1].id),
  ).toBe(true);
  // Ground cover is life-sized and distance-culled; verify the painted plants also render close up.
  await page.mouse.move(
    viewport.x + viewport.width * 0.5,
    viewport.y + viewport.height * 0.5,
  );
  await page.mouse.wheel(0, -3000);
  await expect
    .poll(async () =>
      Number(
        (await page.locator('#foliage-detail-stats').textContent())
          .split(' plants')[0]
          .replaceAll(',', ''),
      ),
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/photoreal-ferns-painted.png' });
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, 'photoreal-undone')).toEqual(before);
  await page.locator('#redo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, 'photoreal-redone')).toEqual(painted);
  const download = page.waitForEvent('download');
  await (await inspectorControl(page, '#save-brush')).click();
  await (await download).saveAs('test-results/photoreal-fern.foliage.json');
  const brush = JSON.parse(
    await readFile('test-results/photoreal-fern.foliage.json', 'utf8'),
  );
  expect(Object.keys(brush.assets)).toHaveLength(4);
  for (const asset of Object.values(brush.assets)) {
    const bytes = Buffer.from(asset.data.split(',')[1], 'base64');
    const gltf = JSON.parse(
      bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)),
    );
    expect(gltf.asset.copyright).toContain('Rico Cilliers');
    expect(gltf.asset.copyright).toContain('Rob Tuytel');
  }
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  // Reopening must use embedded models even if bundled files are unavailable.
  await page.route('**/foliage/photoreal/*.glb', (route) => route.abort());
  await page.reload();
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  expect(await save(page, 'photoreal-reloaded')).toEqual(painted);
  expect(issues).toEqual([]);
});

test('keeps existing brushes and history after failed or cancelled default imports, then retries successfully', async ({
  page,
}) => {
  test.setTimeout(150000);
  const issues = errors(page);
  await page.route('**/foliage/photoreal/*.glb', (route) =>
    route.fulfill({ status: 503, body: 'Injected asset failure' }),
  );
  await page.goto('/');
  await expect(page.locator('#toast')).toContainText(
    'Default foliage unavailable',
    { timeout: 30000 },
  );
  await page.locator('[data-tab=foliage]').click();
  await expect(page.locator('#brush-select option')).toHaveCount(2);
  // Create a real redo step to prove failed preparation does not consume history.
  await (await inspectorControl(page, '#brush-name')).fill('Temporary');
  await (await inspectorControl(page, '#brush-name')).press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  await expect(page.locator('#redo')).toBeEnabled();
  const before = await save(page, 'photoreal-failure-before');
  await (await inspectorControl(page, '#default-foliage')).selectOption('fern');
  await (await inspectorControl(page, '#add-default-foliage')).click();
  await expect(page.locator('#toast')).toContainText(
    'Could not add default brush',
  );
  expect(await save(page, 'photoreal-after-failure')).toEqual(before);
  await expect(page.locator('#redo')).toBeEnabled();
  await page.unroute('**/foliage/photoreal/*.glb');
  let release, requested;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const arrived = new Promise((resolve) => {
    requested = resolve;
  });
  await page.route('**/foliage/photoreal/*.glb', async (route) => {
    requested();
    await gate;
    await route.continue().catch(() => {});
  });
  await (await inspectorControl(page, '#add-default-foliage')).click();
  await arrived;
  await page.locator('#cancel-preparation').click();
  release();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, 'photoreal-after-cancel')).toEqual(before);
  await expect(page.locator('#redo')).toBeEnabled();
  await page.unroute('**/foliage/photoreal/*.glb');
  await (await inspectorControl(page, '#add-default-foliage')).click();
  await expect(page.locator('#toast')).toContainText('Photoreal brush added', {
    timeout: 30000,
  });
  const added = await save(page, 'photoreal-added');
  expect(added.brushes.slice(0, 2)).toEqual(before.brushes);
  expect(added.brushes).toHaveLength(3);
  expect(Object.keys(added.assets)).toHaveLength(4);
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, 'photoreal-add-undone')).toEqual(before);
  await page.locator('#redo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, 'photoreal-add-redone')).toEqual(added);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  expect(await save(page, 'photoreal-add-reloaded')).toEqual(added);
  expect(issues).toEqual([]);
});
