import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { seedEditorProject } from './seed-editor-project.mjs';
import { decodeDocument } from './fixtures.mjs';

test('startup shows animated stage progress while default brushes load', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/foliage/photoreal/assets.json', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/');
  const modal = page.getByRole('dialog', { name: 'Opening your world' });
  await expect(modal).toBeVisible();
  await expect(modal.locator('#startup-stage')).toHaveText(
    'Loading default brushes…',
    { timeout: 30000 },
  );
  await expect(modal.getByRole('progressbar')).toHaveAttribute('value', '2');
  await expect(modal.locator('#startup-steps')).toHaveText('Step 3 of 8');
  expect(await page.locator('#app').evaluate((app) => app.inert)).toBe(true);
  await expect(page.locator('#preparation-status')).toBeHidden();
  const spinner = modal.locator('.startup-spinner');
  const before = await spinner.evaluate((el) => getComputedStyle(el).transform);
  await expect
    .poll(() => spinner.evaluate((el) => getComputedStyle(el).transform))
    .not.toBe(before);
  await page.keyboard.press('Escape');
  await expect(modal).toBeVisible();
  await page.screenshot({ path: info.outputPath('loading-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(spinner).toHaveCSS('animation-name', 'none');
  const box = await modal.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('loading-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  release();
  await expect(modal).toHaveCount(0, { timeout: 120000 });
  expect(await page.locator('#app').evaluate((app) => app.inert)).toBe(false);
  await expect(page.locator('#foliage-count')).not.toHaveText('0');
  expect(errors).toEqual([]);
});

test('restored projects stay covered until the first view finishes on the GPU', async ({
  page,
}) => {
  test.setTimeout(120000);
  await seedEditorProject(page);
  await page.addInitScript(() => {
    const done = GPUQueue.prototype.onSubmittedWorkDone;
    const waiting = [];
    let hold = true;
    window.releaseStartupFrame = () => {
      hold = false;
      waiting.splice(0).forEach((resolve) => resolve());
    };
    GPUQueue.prototype.onSubmittedWorkDone = function () {
      const result = done.call(this);
      if (
        hold &&
        document.querySelector('#startup-stage')?.textContent ===
          'Rendering the first view…'
      ) {
        window.startupFrameHeld = true;
        return Promise.all([
          result,
          new Promise((resolve) => waiting.push(resolve)),
        ]);
      }
      return result;
    };
  });
  await page.goto('/');
  await page.waitForFunction(() => window.startupFrameHeld);
  await expect(page.locator('#startup-loading')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '7');
  expect(await page.locator('#app').evaluate((app) => app.inert)).toBe(true);
  await page.evaluate(() => window.releaseStartupFrame());
  await expect(page.locator('#startup-loading')).toHaveCount(0);
  await expect(page.locator('#project-name')).toHaveValue(
    'Saved editor fixture',
  );
  expect(await page.locator('#app').evaluate((app) => app.inert)).toBe(false);
});

test('unavailable default assets fall back to basic brushes and finish loading', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.route('**/foliage/photoreal/assets.json', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 60000,
  });
  await expect(page.locator('#startup-loading')).toHaveCount(0);
  await expect(page.locator('#foliage-count')).not.toHaveText('0');
  await expect(page.locator('#toast')).toContainText('opened basic brushes');
});

test('startup failure stops loading, preserves the local save and can retry', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await seedEditorProject(page);
  await page.addInitScript(() => {
    const done = GPUQueue.prototype.onSubmittedWorkDone;
    GPUQueue.prototype.onSubmittedWorkDone = function () {
      if (
        !sessionStorage.getItem('startup-retry') &&
        document.querySelector('#startup-stage')?.textContent ===
          'Rendering the first view…'
      )
        return Promise.reject(new Error('Injected first-view failure'));
      return done.call(this);
    };
  });
  await page.goto('/');
  const modal = page.getByRole('dialog', { name: 'Could not open this world' });
  await expect(modal).toBeVisible({ timeout: 30000 });
  await expect(modal).toContainText('Injected first-view failure');
  await expect(modal.getByRole('progressbar')).toBeHidden();
  await expect(modal.locator('.startup-spinner')).toBeHidden();
  expect(await page.locator('#app').evaluate((app) => app.inert)).toBe(true);
  const downloaded = page.waitForEvent('download');
  await modal
    .getByRole('button', { name: 'Download locally saved project' })
    .click();
  const path = info.outputPath('recovered.terrain');
  await (await downloaded).saveAs(path);
  const saved = decodeDocument(await readFile(path));
  expect(saved.name).toBe('Saved editor fixture');
  expect(saved.foliage).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('startup-error.png') });
  await page.evaluate(() => sessionStorage.setItem('startup-retry', '1'));
  await modal.getByRole('button', { name: 'Reload', exact: true }).click();
  // Wait for the restored document before checking readiness: the new page's
  // empty #app exists briefly before the module installs the startup modal.
  await expect(page.locator('#project-name')).toHaveValue(saved.name);
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 30000,
  });
  await expect(page.locator('#startup-loading')).toHaveCount(0);
  expect(await page.locator('#app').evaluate((app) => app.inert)).toBe(false);
});
