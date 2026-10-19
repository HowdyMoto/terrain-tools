import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createProject, serializeProject } from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';
import { inspectorControl } from './inspector-controls.mjs';

test.setTimeout(180000);
async function setup(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (
      m.type() === 'error' &&
      /THREE|Shader|WebGL/i.test(m.text()) &&
      !m.text().includes('Injected water texture')
    )
      errors.push(m.text());
  });
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  const p = createProject(64, 96);
  p.name = 'Water coast';
  p.view.water = false;
  p.view.waterLevel = 0;
  p.view.textureResolution = 256;
  for (let z = 0; z <= 64; z++)
    for (let x = 0; x <= 64; x++) {
      const px = (x / 64 - 0.5) * 96,
        pz = (z / 64 - 0.5) * 96;
      p.heights[z * 65 + x] = -4 + 15 * Math.exp(-(px * px + pz * pz) / 500);
    }
  p.foliage = [];
  await page.locator('#file-open').setInputFiles({
    name: 'water.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(p)),
  });
  await expect(page.locator('#project-name')).toHaveValue(p.name, {
    timeout: 60000,
  });
  await page.locator('#frame').click();
  await page.locator('[data-tab="water"]').click();
  return errors;
}
async function value(page, id, value) {
  const input = await inspectorControl(page, '#' + id);
  await input.evaluate((el, value) => {
    if (typeof value === 'boolean') el.checked = value;
    else el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
}
async function save(page, info, name) {
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return { data: await decodeDocument(await readFile(path)), path };
}
test('ocean optics, multiple bodies, native round trip and undo', async ({
  page,
}, info) => {
  const errors = await setup(page);
  const legacy = await save(page, info, 'legacy');
  expect(legacy.data.water).toBeUndefined();
  await expect(
    page.getByRole('button', { name: 'Enable realistic water' }),
  ).toHaveCount(0);
  for (const name of ['Shape', 'Appearance', 'Waves', 'Shore']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(
      page.getByRole('checkbox', { name: 'Show ocean', exact: true }),
    ).toBeInViewport();
    await expect(page.locator('#water-context .switch')).toBeVisible();
    await expect(
      page.getByRole('spinbutton', { name: 'Water height (m)', exact: true }),
    ).toBeInViewport();
  }
  expect((await save(page, info, 'browsed')).data).toEqual(legacy.data);
  await page.getByRole('checkbox', { name: 'Show ocean', exact: true }).check();
  await expect(page.locator('#water-body')).toBeVisible();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  await page
    .getByRole('spinbutton', { name: 'Water height (m)', exact: true })
    .fill('1');
  await page.locator('#water-sea-level').press('Tab');
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  await page.locator('#undo').click();
  await expect(page.locator('#water-sea-level')).toHaveValue(
    String(legacy.data.view.waterLevel),
  );
  await expect(page.locator('#water')).toBeChecked();
  await page.locator('#redo').click();
  await expect(page.locator('#water-sea-level')).toHaveValue('1');
  await (
    await inspectorControl(page, '#water-preset')
  ).selectOption('tropical');
  await value(page, 'water-swellHeight', 0.6);
  await expect(page.locator('#water-sea-level')).toBeInViewport();
  await expect(page.locator('#water')).toBeInViewport();
  await page
    .locator('.inspector')
    .screenshot({ path: info.outputPath('water-height-and-waves.png') });
  await page.mouse.move(30, 30);
  await page.waitForTimeout(1000);
  await page
    .locator('#viewport')
    .screenshot({ path: info.outputPath('tropical-coast.png') });
  const ocean = await save(page, info, 'ocean');
  expect(ocean.data.water.seaLevel).toBe(1);
  expect(ocean.data.water.ocean.surface.swellHeight).toBe(0.6);
  await (await inspectorControl(page, '#water-add-ellipse')).click();
  const bounds = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(
    bounds.x + bounds.width * 0.5,
    bounds.y + bounds.height * 0.5,
  );
  await expect(page.locator('#water-body option')).toHaveCount(2);
  const selected = await page.locator('#water-body').inputValue();
  for (const name of ['Shape', 'Appearance', 'Waves', 'Shore']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(
      page.getByRole('checkbox', { name: 'Show this body', exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole('spinbutton', { name: 'Water height (m)', exact: true }),
    ).toBeInViewport();
  }
  await page
    .getByRole('spinbutton', { name: 'Water height (m)', exact: true })
    .fill('10');
  await page.locator('#water-elevation').press('Tab');
  await (await inspectorControl(page, '#water-preset')).selectOption('pond');
  await page.locator('#water-body').selectOption('ocean');
  await expect(page.locator('#water-sea-level')).toHaveValue('1');
  await page
    .getByRole('checkbox', { name: 'Show ocean', exact: true })
    .uncheck();
  const pond = await save(page, info, 'pond');
  expect(pond.data.water.ocean.enabled).toBe(false);
  expect(pond.data.water.bodies[0].elevation).toBe(10);
  expect(pond.data.water.bodies[0].enabled).toBe(true);
  expect(pond.data.water.bodies[0].surface.visibility).toBe(1.8);
  await page.locator('#undo').click();
  await expect(await inspectorControl(page, '#water')).toBeChecked();
  await page.locator('#redo').click();
  await expect(await inspectorControl(page, '#water')).not.toBeChecked();
  await page.locator('#water-body').selectOption(selected);
  await page
    .getByRole('checkbox', { name: 'Show this body', exact: true })
    .uncheck();
  const hidden = await save(page, info, 'hidden-pond');
  expect(hidden.data.water.bodies[0].enabled).toBe(false);
  expect(hidden.data.water.ocean.enabled).toBe(false);
  await page.locator('#undo').click();
  await expect(page.locator('#water-body-enabled')).toBeChecked();
  await page.locator('#file-open').setInputFiles(pond.path);
  await expect(page.locator('#project-name')).toHaveValue('Water coast');
  await page.getByText('Project loaded.', { exact: true }).waitFor();
  const reopened = await save(page, info, 'reopened');
  expect(reopened.data.water).toEqual(pond.data.water);
  expect(errors).toEqual([]);
});
test('failed GPU water preparation preserves the document and redo, then retries', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const original = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (descriptor) {
      const width = descriptor.size.width ?? descriptor.size[0];
      if (
        window.failWaterFoam &&
        descriptor.format === 'rgba8unorm' &&
        width === 1024
      ) {
        window.failWaterFoam = false;
        window.waterFaults = (window.waterFaults || 0) + 1;
        throw new Error('Injected water texture foam allocation failure');
      }
      if (
        window.failWaterShore &&
        descriptor.format === 'rgba32float' &&
        width === 65
      ) {
        window.failWaterShore = false;
        window.waterFaults = (window.waterFaults || 0) + 1;
        throw new Error('Injected water texture shoreline allocation failure');
      }
      if (
        window.failWater &&
        descriptor.format === 'r32float' &&
        width === 65
      ) {
        window.failWater = false;
        window.waterFaults = (window.waterFaults || 0) + 1;
        // A real asynchronous validation failure inside the preparation scope.
        // JavaScript succeeds; popErrorScope must reject the candidate.
        this.createBuffer({ size: 4, usage: 0 }).destroy();
      }
      return original.call(this, descriptor);
    };
  });
  const errors = await setup(page);
  await page.locator('#project-name').fill('Redo water branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#redo')).toBeEnabled();
  const before = await save(page, info, 'before-failure');
  await page.evaluate(() => {
    window.failWater = true;
  });
  await page.locator('#water').click();
  await expect(page.locator('#toast')).toContainText('previous water was kept');
  expect(await page.evaluate(() => window.waterFaults)).toBe(1);
  await expect(page.locator('#redo')).toBeEnabled();
  const after = await save(page, info, 'after-failure');
  expect(after.data).toEqual(before.data);
  await expect(page.locator('#water')).not.toBeChecked();
  await page.evaluate(() => {
    window.failWaterFoam = true;
  });
  await page.locator('#water').click();
  await expect(page.locator('#toast')).toContainText('previous water was kept');
  expect(await page.evaluate(() => window.waterFaults)).toBe(2);
  await expect(page.locator('#redo')).toBeEnabled();
  expect((await save(page, info, 'after-foam-failure')).data).toEqual(
    before.data,
  );
  await expect(page.locator('#water')).not.toBeChecked();
  await page.locator('#water').check();
  await expect(page.locator('#water-body')).toBeVisible();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  await page.locator('#undo').click();
  await expect(page.locator('#water')).not.toBeChecked();
  expect((await save(page, info, 'undo-enable')).data).toEqual(before.data);
  await page.locator('#redo').click();
  await expect(page.locator('#water-body')).toBeVisible();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  await expect(page.locator('#water')).toBeChecked();
  await (await inspectorControl(page, '#water-add-ellipse')).click();
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.locator('#water-body option')).toHaveCount(2);
  const selected = await page.locator('#water-body').inputValue();
  await page.evaluate(() => {
    window.failWater = true;
  });
  await (await inspectorControl(page, '#water-duplicate')).click();
  await expect(page.locator('#toast')).toContainText('previous water was kept');
  await expect(page.locator('#water-body')).toHaveValue(selected);
  await expect(page.locator('#water-body option')).toHaveCount(2);
  await (await inspectorControl(page, '#water-duplicate')).click();
  await expect(page.locator('#water-body option')).toHaveCount(3);
  await expect(page.locator('#water-body')).not.toHaveValue(selected);
  const beforeShore = await save(page, info, 'before-shore-failure');
  await page.evaluate(() => {
    window.failWaterShore = true;
  });
  await value(page, 'water-wetness', 0.9);
  await expect(page.locator('#toast')).toContainText('previous water was kept');
  const afterShore = await save(page, info, 'after-shore-failure');
  expect(afterShore.data).toEqual(beforeShore.data);
  await value(page, 'water-wetness', 0.9);
  expect(
    (await save(page, info, 'shore-retry')).data.water.bodies.at(-1).surface
      .wetness,
  ).toBe(0.9);
  expect(errors).toEqual([]);
});
