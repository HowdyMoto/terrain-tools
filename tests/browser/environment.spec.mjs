import { inspectorControl } from './inspector-controls.mjs';
import { decodeDocument } from './fixtures.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeHeightmapPNG } from '../../lib/core.js';
import { createProject, serializeProject } from '../../lib/core.js';
import { exrFixture } from '../fixtures/environment-exr.ts';
function hdr() {
  const width = 64,
    height = 32,
    header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 32 +X 64\n');
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels.set(
        [
          70 + Math.round((100 * x) / 63),
          110 + Math.round(80 * (1 - y / 31)),
          140,
          129,
        ],
        (y * width + x) * 4,
      );
  return Buffer.concat([header, pixels]);
}
async function range(page, key, value) {
  await page.locator('#env-' + key).evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
}
async function save(page, name) {
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = 'test-results/' + name + '.json';
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function brightness(page) {
  const png = await page
    .getByLabel('Interactive terrain viewport')
    .screenshot();
  const map = await decodeHeightmapPNG(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
  );
  return map.values.reduce((sum, v) => sum + v, 0) / map.values.length;
}
function errors(page) {
  const messages = [];
  page.on('pageerror', (e) => messages.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /THREE|Shader|WebGL/i.test(m.text()))
      messages.push(m.text());
  });
  return messages;
}
test('imports EXR illumination, rejects a damaged replacement, and restores it through undo, autosave and GLB', async ({
  page,
  context,
}) => {
  test.setTimeout(240000);
  const issues = errors(page);
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  // Keep format/recovery assertions independent of the large default asset collection.
  await page.locator('#file-open').setInputFiles({
    name: 'exr-test.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(createProject(16, 32))),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 60000,
  });
  await page.locator('[data-tab=light]').click();
  await expect(page.locator('#environment-open')).toHaveAttribute(
    'accept',
    '.hdr,.exr',
  );
  const bytes = Buffer.from(await exrFixture());
  await page.locator('#environment-open').setInputFiles({
    name: 'Linear sky.exr',
    mimeType: 'image/x-exr',
    buffer: bytes,
  });
  await expect(page.locator('#toast')).toHaveText('Environment imported.');
  await range(page, 'rotation', 35);
  const imported = await save(page, 'exr-imported');
  expect(imported.environment.image).toEqual({
    name: 'Linear sky.exr',
    data: 'data:application/octet-stream;base64,' + bytes.toString('base64'),
  });
  await page.locator('#environment-open').setInputFiles({
    name: 'Broken.exr',
    mimeType: 'image/x-exr',
    buffer: bytes.subarray(0, -8),
  });
  await expect(page.locator('#toast')).toContainText(
    'Could not import environment',
  );
  expect(await save(page, 'exr-after-invalid')).toEqual(imported);
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  await expect(page.locator('#env-rotation')).toHaveValue('0');
  await page.locator('#redo').click();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  expect(await save(page, 'exr-redone')).toEqual(imported);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  await page.locator('[data-tab=light]').click();
  await expect(page.locator('#env-rotation')).toHaveValue('35');
  expect(await save(page, 'exr-reloaded')).toEqual(imported);
  await page.screenshot({ path: 'test-results/exr-environment.png' });
  const pending = page.waitForEvent('download');
  await page.locator('#export').click();
  await (await pending).saveAs('test-results/exr-scene.glb');
  await page.locator('#file-open').setInputFiles('test-results/exr-scene.glb');
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 60000,
  });
  expect(await save(page, 'exr-glb-reopened')).toEqual(imported);
  const runtime = await context.newPage(),
    runtimeIssues = errors(runtime);
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances', {
    timeout: 30000,
  });
  await runtime
    .locator('#open-project')
    .setInputFiles('test-results/exr-scene.glb');
  await expect(runtime.locator('#lighting')).toContainText('HDRI');
  expect(issues).toEqual([]);
  expect(runtimeIssues).toEqual([]);
  await runtime.close();
});
test('authors lighting and HDRI, recovers invalid imports, and restores the authored look in JSON, GLB and runtime', async ({
  page,
  context,
}) => {
  test.setTimeout(240000);
  const issues = errors(page);
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  await page.locator('[data-tab=wind]').click();
  await (await inspectorControl(page, '#wind-enabled')).uncheck();
  await page.locator('[data-tab=light]').click();
  await (
    await inspectorControl(page, '#environment-preset')
  ).selectOption('golden');
  await expect(page.locator('#env-sunElevation')).toHaveValue('16');
  await range(page, 'exposure', 0.3);
  const dark = await brightness(page);
  await range(page, 'exposure', 2);
  const bright = await brightness(page);
  expect(bright).toBeGreaterThan(dark + 0.08);
  await range(page, 'exposure', 1.1);
  await page.screenshot({ path: 'test-results/lighting-golden.png' });
  const golden = await save(page, 'lighting-golden');
  expect(golden.environment).toMatchObject({
    mode: 'sky',
    sunElevation: 16,
    exposure: 1.1,
  });
  await page.locator('#environment-open').setInputFiles({
    name: 'Test sky.hdr',
    mimeType: 'application/octet-stream',
    buffer: hdr(),
  });
  await expect(page.locator('#toast')).toHaveText('Environment imported.');
  await range(page, 'rotation', 65);
  await range(page, 'sunAzimuth', 65);
  await (await inspectorControl(page, '#env-fogEnabled')).uncheck();
  await (
    await inspectorControl(page, '#env-toneMapping')
  ).selectOption('neutral');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const imported = await save(page, 'lighting-hdri');
  expect(imported.environment).toMatchObject({
    mode: 'image',
    rotation: 65,
    sunAzimuth: 65,
    fogEnabled: false,
    toneMapping: 'neutral',
  });
  expect(imported.environment.image.data).toBe(
    'data:application/octet-stream;base64,' + hdr().toString('base64'),
  );
  await page.locator('#environment-open').setInputFiles({
    name: 'broken.hdr',
    mimeType: 'application/octet-stream',
    buffer: hdr().subarray(0, -4),
  });
  await expect(page.locator('#toast')).toContainText(
    'Could not import environment',
  );
  expect(await save(page, 'lighting-after-invalid')).toEqual(imported);
  // A malformed embedded HDR in an otherwise valid project must also be rejected before replacement.
  const broken = {
    ...imported,
    name: 'Broken HDR project',
    environment: {
      ...imported.environment,
      image: {
        name: 'bad.hdr',
        data: 'data:application/octet-stream;base64,YmFk',
      },
    },
  };
  await page.locator('#file-open').setInputFiles({
    name: 'bad-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(broken)),
  });
  await expect(page.locator('#toast')).toContainText('Could not open project');
  expect(await save(page, 'lighting-after-bad-project')).toEqual(imported);
  await (await inspectorControl(page, '#remove-environment')).click();
  await expect(page.locator('#env-mode')).toHaveValue('sky');
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  await expect(page.locator('#env-mode')).toHaveValue('image');
  expect(await save(page, 'lighting-undone')).toEqual(imported);
  await page.reload();
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  await page.locator('[data-tab=light]').click();
  await expect(page.locator('#env-rotation')).toHaveValue('65');
  expect(await save(page, 'lighting-reloaded')).toEqual(imported);
  await page.screenshot({ path: 'test-results/lighting-hdri.png' });
  const pending = page.waitForEvent('download');
  await page.locator('#export').click();
  await (await pending).saveAs('test-results/lighting-scene.glb');
  await page
    .locator('#file-open')
    .setInputFiles('test-results/lighting-scene.glb');
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 60000,
  });
  expect(await save(page, 'lighting-glb-reopened')).toEqual(imported);
  expect(issues).toEqual([]);
  const runtime = await context.newPage(),
    runtimeIssues = errors(runtime);
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances', {
    timeout: 30000,
  });
  await runtime
    .locator('#open-project')
    .setInputFiles('test-results/lighting-scene.glb');
  await expect(runtime.locator('#lighting')).toContainText(
    'HDRI · Neutral · exposure 1.10',
  );
  await runtime.screenshot({ path: 'test-results/lighting-runtime.png' });
  expect(runtimeIssues).toEqual([]);
  await runtime.close();
});
