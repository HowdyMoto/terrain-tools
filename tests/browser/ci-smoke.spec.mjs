import { test, expect as baseExpect } from '@playwright/test';
import { createProject, serializeProject } from 'terrain-tools';
import { seedEditorProject } from './seed-editor-project.mjs';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
// Software-rendered CI verifies behavior, with a smaller viewport and bounded
// readiness waits. Its timings must never be used as dedicated-GPU evidence.
const expect = baseExpect.configure({ timeout: 45000 });
test.use({ viewport: { width: 960, height: 640 } });

test('clean build opens a saved fixture, imports a terrain, and restores an authored change', async ({
  page,
}, info) => {
  test.setTimeout(process.env.CI ? 420000 : 180000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: process.env.CI ? 180000 : 60000,
  });
  const p = createProject(32, 64);
  p.name = 'CI fixture';
  p.foliage = [];
  p.props = [];
  p.view.textureResolution = 256;
  await page.locator('#file-open').setInputFiles({
    name: 'ci.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(p)),
  });
  await expect(page.locator('#project-name')).toHaveValue('CI fixture');
  await page.locator('#project-name').fill('Edited fixture');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue('CI fixture');
  await page.locator('#redo').click();
  await expect(page.locator('#project-name')).toHaveValue('Edited fixture');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue('Edited fixture');
  const pending = page.waitForEvent('download');
  await page.locator('#screenshot').click();
  const png = await pending;
  expect(png.suggestedFilename()).toBe('terrain-studio.png');
  const path = info.outputPath('viewport.png');
  await png.saveAs(path);
  const captured = sharp(await readFile(path));
  const stats = await captured.stats();
  await info.attach('viewport-pixels', {
    body: JSON.stringify(stats, null, 2),
    contentType: 'application/json',
  });
  expect((await captured.metadata()).format).toBe('png');
  expect(stats.isOpaque).toBe(true);
  expect(stats.channels.slice(0, 3).some((c) => c.stdev > 5)).toBe(true);
  expect(errors).toEqual([]);
});
