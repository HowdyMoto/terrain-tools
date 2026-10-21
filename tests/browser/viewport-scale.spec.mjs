import { test, expect } from '@playwright/test';
import { seedEditorProject } from './seed-editor-project.mjs';

test('moving between display scales resizes the drawing buffer without a layout resize or document edit', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    window.viewportTestScale = 1;
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => window.viewportTestScale,
    });
  });
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 60000,
  });
  const canvas = page.locator('#viewport canvas');
  const before = await canvas.evaluate((c) => ({
    width: c.width,
    height: c.height,
    css: [c.clientWidth, c.clientHeight],
  }));
  const history = await page
    .locator('#undo, #redo')
    .evaluateAll((nodes) =>
      nodes.map((n) => ({ title: n.title, disabled: n.disabled })),
    );
  // No window resize or ResizeObserver notification: only display scaling changes.
  await page.evaluate(() => {
    window.viewportTestScale = 2;
  });
  await expect
    .poll(() => canvas.evaluate((c) => c.width))
    .toBe(before.width * 2);
  expect(await canvas.evaluate((c) => [c.clientWidth, c.clientHeight])).toEqual(
    before.css,
  );
  await page.evaluate(() => {
    window.viewportTestScale = 1;
  });
  await expect.poll(() => canvas.evaluate((c) => c.width)).toBe(before.width);
  await expect.poll(() => canvas.evaluate((c) => c.height)).toBe(before.height);
  expect(
    await page
      .locator('#undo, #redo')
      .evaluateAll((nodes) =>
        nodes.map((n) => ({ title: n.title, disabled: n.disabled })),
      ),
  ).toEqual(history);
});
