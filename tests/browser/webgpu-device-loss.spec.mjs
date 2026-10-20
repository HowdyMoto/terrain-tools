import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeDocument } from './fixtures.mjs';

test('native device loss preserves the authored project and offers saving before reload', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await request.apply(this, args);
      // Three ignores deliberate destruction. Use a real destroyed device but
      // report an unexpected loss so its production recovery callback runs.
      Object.defineProperty(device, 'lost', {
        value: device.lost.then((info) => ({
          reason: 'unknown',
          message: info.message,
        })),
      });
      window.editorDevice ??= device;
      return device;
    };
  });
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 60000,
  });
  await page.locator('#project-name').fill('Device loss recovery');
  await page.locator('#project-name').press('Tab');
  const save = async (button, name) => {
    const pending = page.waitForEvent('download');
    await button.click();
    const file = info.outputPath(name + '.terrain');
    await (await pending).saveAs(file);
    return decodeDocument(await readFile(file));
  };
  const before = await save(page.locator('#save'), 'before');
  await page.evaluate(() => window.editorDevice.destroy());
  const notice = page.locator('.renderer-notice');
  await expect(notice).toContainText('graphics device disconnected');
  await expect(page.locator('#app')).toHaveAttribute('inert');
  const after = await save(
    notice.getByRole('button', { name: 'Save project' }),
    'after',
  );
  expect(after).toEqual(before);
  expect(after.name).toBe('Device loss recovery');
  await expect(notice.getByRole('button', { name: 'Reload' })).toBeEnabled();
});
