import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProject,
  generateTerrain,
  serializeProject,
  parseSculptPreset,
} from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';

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
  const file = await pending;
  await file.saveAs(path);
  return { name: file.suggestedFilename(), bytes: await readFile(path) };
}
async function save(page, suffix) {
  return decodeDocument(
    (
      await download(
        page,
        '#save',
        'test-results/sculpt-preset-' + suffix + '.terrain',
      )
    ).bytes,
  );
}
test('reuses precise sculpt presets across projects with undo, autosave, validation and stale-import recovery', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await (await inspectorControl(page, '#preset')).selectOption('flat');
  await (await inspectorControl(page, '#resolution')).selectOption('32');
  await (await inspectorControl(page, '#generate')).click();
  const fixtures = JSON.parse(
    await readFile(
      new URL('../fixtures/heightmaps.json', import.meta.url),
      'utf8',
    ),
  );
  await page.locator('#alpha-open').setInputFiles({
    name: 'Precise ridge.png',
    mimeType: 'image/png',
    buffer: Buffer.from(fixtures.filters, 'base64'),
  });
  await expect(page.locator('#toast')).toContainText('Alpha imported');
  await range(page, 'radius', 18);
  await range(page, 'strength', 0.75);
  await range(page, 'falloff', 0.25);
  await range(page, 'target', -6);
  await range(page, 'alpha-rotation', 90);
  await range(page, 'stamp-height', 12);
  await range(page, 'stamp-base', -3);
  await range(page, 'erode-talus', 23);
  await (await inspectorControl(page, '[data-tool="stamp"]')).click();
  await (await inspectorControl(page, '#stamp-mode')).selectOption('set');
  await (await inspectorControl(page, '#pen-pressure')).uncheck();
  await (
    await inspectorControl(page, '#sculpt-preset-name')
  ).fill('Cliff "edge" <ridge>');
  await (await inspectorControl(page, '#sculpt-preset-name')).press('Tab');
  const original = await save(page, 'original');
  const exported = await download(
    page,
    '#export-sculpt-preset',
    'test-results/artist-brush.sculpt.json',
  );
  expect(exported.name).toMatch(/\.sculpt\.json$/);
  const preset = parseSculptPreset(exported.bytes.toString());
  expect(preset.settings.alpha.values[1]).toBeLessThan(1 / 255);
  expect(JSON.parse(exported.bytes.toString()).settings).toEqual(
    original.sculpt,
  );
  expect(preset.talus).toBe(23);
  expect(exported.bytes.toString()).not.toContain('"heights"');

  await (await inspectorControl(page, '[data-tool="lower"]')).click();
  await range(page, 'radius', 4);
  await (await inspectorControl(page, '#alpha-kind')).selectOption('none');
  await range(page, 'erode-talus', 60);
  const beforeLoad = await save(page, 'before-load');
  await page
    .locator('#sculpt-preset-open')
    .setInputFiles('test-results/artist-brush.sculpt.json');
  await expect(page.locator('#toast')).toContainText('Sculpt preset loaded');
  await expect(page.locator('#radius')).toHaveValue('18');
  await expect(page.locator('#strength')).toHaveValue('0.75');
  await expect(page.locator('#falloff')).toHaveValue('0.25');
  await expect(page.locator('#target')).toHaveValue('-6');
  await expect(page.locator('#sculpt-preset-name')).toHaveValue(
    'Cliff "edge" <ridge>',
  );
  await expect(page.locator('[data-tool="stamp"]')).toHaveClass(/active/);
  const loaded = await save(page, 'loaded');
  expect(loaded.sculpt).toEqual(original.sculpt);
  expect(loaded.heights).toEqual(beforeLoad.heights);
  await page.locator('#undo').click();
  await expect(page.locator('#radius')).toHaveValue('4');
  await expect(page.locator('[data-tool="lower"]')).toHaveClass(/active/);
  const undone = await save(page, 'undone');
  expect(undone.sculpt).toEqual(beforeLoad.sculpt);
  expect(undone.erosion).toEqual(beforeLoad.erosion);
  await page.locator('#redo').click();
  await expect(page.locator('#radius')).toHaveValue('18');

  const historyBefore = await page.locator('#undo').getAttribute('title');
  const invalid = JSON.parse(exported.bytes.toString());
  invalid.settings.brush.tool = 'prop';
  await page.locator('#sculpt-preset-open').setInputFiles({
    name: 'invalid.sculpt.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.locator('#toast')).toContainText(
    'Could not load sculpt preset',
  );
  expect(await page.locator('#undo').getAttribute('title')).toBe(historyBefore);
  expect((await save(page, 'invalid')).sculpt).toEqual(original.sculpt);

  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#radius')).toHaveValue('18', { timeout: 30000 });
  await expect(page.locator('[data-tool="stamp"]')).toHaveClass(/active/);
  await page.locator('[data-tab="foliage"]').click();
  await range(page, 'radius', 3);
  await page.locator('[data-tab="sculpt"]').click();
  await expect(page.locator('#radius')).toHaveValue('18');
  await expect(page.locator('[data-tool="stamp"]')).toHaveClass(/active/);

  const fresh = createProject(32, 64);
  generateTerrain(fresh, 'flat');
  delete fresh.sculpt; // Older project files have no saved brush controls.
  await page.locator('#file-open').setInputFiles({
    name: 'another-terrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(fresh)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await expect(page.locator('#radius')).toHaveValue('12');
  await expect(page.locator('[data-tool="raise"]')).toHaveClass(/active/);
  await page
    .locator('#sculpt-preset-open')
    .setInputFiles('test-results/artist-brush.sculpt.json');
  await expect(page.locator('#toast')).toContainText('Sculpt preset loaded');
  const reused = await save(page, 'reused');
  expect(reused.sculpt).toEqual(original.sculpt);
  expect(reused.heights).toEqual(Array.from(fresh.heights));
  await page.locator('#frame').click();
  const box = await page
    .getByLabel('Interactive terrain viewport')
    .boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.57);
  const stamped = await save(page, 'stamped');
  expect(stamped.heights.some((value) => value !== 0)).toBe(true);
  expect(stamped.sculpt).toEqual(original.sculpt);
  await page.locator('#undo').click();
  expect((await save(page, 'stamp-undone')).heights).toEqual(reused.heights);
  const glb = await download(
    page,
    '#export',
    'test-results/sculpt-preset-scene.glb',
  );
  expect(decodeDocument(glb.bytes).sculpt).toEqual(original.sculpt);

  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      const text = original.call(this);
      if (this.name !== 'held.sculpt.json') return text;
      return new Promise((resolve, reject) => {
        window.releasePresetRead = () => text.then(resolve, reject);
      });
    };
  });
  await page.locator('#sculpt-preset-open').setInputFiles({
    name: 'held.sculpt.json',
    mimeType: 'application/json',
    buffer: exported.bytes,
  });
  await page.waitForFunction(
    () => typeof window.releasePresetRead === 'function',
  );
  await range(page, 'radius', 7);
  const beforeStale = await page.locator('#undo').getAttribute('title');
  await page.evaluate(() => window.releasePresetRead());
  await expect(page.locator('#toast')).toContainText(
    'document changed during import',
  );
  await expect(page.locator('#radius')).toHaveValue('7');
  expect(await page.locator('#undo').getAttribute('title')).toBe(beforeStale);
  expect((await save(page, 'stale')).sculpt.brush.radius).toBe(7);
  await (
    await inspectorControl(page, '#import-sculpt-preset')
  ).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/sculpt-presets-editor.png' });
  expect(errors).toEqual([]);
});
