import { test, expect } from '@playwright/test';
import { createProject, serializeProject } from 'terrain-tools';

test('clean build opens, imports a terrain, and restores an authored change', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 60000,
  });
  const p = createProject(32, 64);
  p.name = 'CI fixture';
  p.foliage = [];
  p.props = [];
  p.view.textureResolution = 256;
  await page
    .locator('#file-open')
    .setInputFiles({
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
  expect(errors).toEqual([]);
});
