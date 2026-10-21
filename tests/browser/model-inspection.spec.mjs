import { test, expect as baseExpect } from '@playwright/test';
import sharp from 'sharp';
import { seedEditorProject } from './seed-editor-project.mjs';
import { solidPng, triangleGlb } from './fixtures.mjs';
import { inspectorControl } from './inspector-controls.mjs';

const expect = baseExpect.configure({ timeout: 30000 });
async function modelFile() {
  const second = await sharp(solidPng(50, 180, 70))
    .resize(8, 2)
    .png()
    .toBuffer();
  return {
    name: 'Textured plant.glb',
    mimeType: 'model/gltf-binary',
    buffer: triangleGlb({
      images: [solidPng(190, 80, 30), second].map(
        (bytes) => 'data:image/png;base64,' + bytes.toString('base64'),
      ),
    }),
  };
}
async function setup(page) {
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false);
}
async function checkDetails(root) {
  await expect(root.locator('[data-model-triangles]')).toHaveText('2');
  await expect(root.locator('[data-texture-size]')).toHaveText([
    '4 × 4 px',
    '8 × 2 px',
  ]);
  await expect(root).toContainText('Base color');
}

test('reviews geometry and texture sizes before foliage import and retains details for foliage and props', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await setup(page);
  await page.locator('[data-tab=foliage]').click();
  await (await inspectorControl(page, '#import-foliage')).click();
  await page.locator('#foliage-files').setInputFiles(await modelFile());
  await expect(page.locator('.import-status')).toContainText('1 model ready');
  await checkDetails(page.locator('#foliage-model-review'));
  await page.screenshot({ path: info.outputPath('model-import-details.png') });
  await page.locator('.import-apply').click();
  await expect(page.locator('dialog.asset-import')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  await checkDetails(page.locator('.model-asset-details'));
  const asset = await page.locator('#foliage-model').inputValue();
  await page.locator('[data-tab=props]').click();
  await page.locator('#prop-model').selectOption(asset);
  await checkDetails(page.locator('.model-asset-details'));
  await page.locator('#prop-model').selectOption('boulder');
  await expect(page.locator('.model-asset-details')).toContainText(
    'No texture maps',
  );
});

test('direct GLB imports expose model details and the subtle FPS badge stays inside the fullscreen viewport', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await setup(page);
  await page.locator('[data-tab=props]').click();
  await page.locator('#asset-open').setInputFiles(await modelFile());
  await expect(page.locator('#toast')).toHaveText('Model imported.');
  await checkDetails(page.locator('.model-asset-details'));
  await expect(page.locator('.stage #fps')).toHaveText(/^\d+ FPS$/);
  await expect(page.locator('footer #fps')).toHaveCount(0);
  expect(
    await page
      .locator('#fps')
      .evaluate((node) => getComputedStyle(node).pointerEvents),
  ).toBe('none');
  await page.locator('#fullscreen').click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.fullscreenElement?.classList.contains('stage'),
      ),
    )
    .toBe(true);
  const screenWidth = await page.evaluate(() => window.innerWidth);
  await expect(page.locator('.stage')).toHaveJSProperty(
    'clientWidth',
    screenWidth,
  );
  await expect(page.locator('.stage #fps')).toBeVisible();
  const badge = await page.locator('#fps').boundingBox();
  expect(badge.x + badge.width).toBeLessThanOrEqual(screenWidth);
  expect(badge.y).toBeGreaterThanOrEqual(0);
  expect(badge.height).toBeLessThan(32);
  await page.screenshot({ path: info.outputPath('viewport-fps.png') });
  await page.locator('#fullscreen').click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(false);
  await page.locator('#frame').click();
  await page.locator('#walk').click();
  const view = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(view.x + view.width * 0.5, view.y + view.height * 0.55);
  await expect(page.locator('#walk-hint')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await page.mouse.click(
    view.x + view.width * 0.5,
    view.y + view.height * 0.55,
  );
  await expect(page.locator('.stage')).toHaveClass(/walking/);
  await expect(page.locator('.stage #fps')).toBeVisible();
  await page.keyboard.press('v');
});
