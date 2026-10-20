import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProject,
  serializeProject,
  defaultEnvironmentSettings,
} from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';

test('shadow, occlusion and temporal allocation failures preserve the document, history and autosave, then retry', async ({
  page,
}, info) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error' && /THREE|Shader|WebGL/i.test(e.text()))
      errors.push(e.text());
  });
  await page.addInitScript(() => {
    const original = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (...args) {
      if (window.rejectForestFramebuffer) {
        window.rejectForestFramebuffer = false;
        window.caughtForestFramebuffer = true;
        throw new Error('Injected forest texture failure');
      }
      return original.apply(this, args);
    };
  });
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  const p = createProject(16, 32);
  p.name = 'Forest lighting recovery';
  p.view.textureResolution = 256;
  p.view.water = false;
  p.wind.enabled = false;
  p.environment = { ...defaultEnvironmentSettings(), shadowResolution: 1024 };
  await page.locator('#file-open').setInputFiles({
    name: 'forest.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(p)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 60000,
  });
  await page.locator('[data-tab=light]').click();
  const save = async (name) => {
    await expect(page.locator('#preparation-status')).toBeHidden({
      timeout: 60000,
    });
    const event = page.waitForEvent('download');
    await page.locator('#save').click();
    const file = info.outputPath(name + '.terrain');
    await (await event).saveAs(file);
    return decodeDocument(await readFile(file));
  };
  const history = () =>
    page
      .locator('#undo,#redo')
      .evaluateAll((elements) =>
        elements.map((e) => ({ disabled: e.disabled, title: e.title })),
      );
  for (const feature of ['cascades', 'occlusion', 'temporal']) {
    const baseline = await save(feature + '-before');
    const beforeHistory = await history();
    await page.evaluate((feature) => {
      window.rejectForestFramebuffer = true;
      window.caughtForestFramebuffer = false;
      const input = document.querySelector(
        feature === 'cascades'
          ? '#env-shadowCascades'
          : feature === 'occlusion'
            ? '#env-ao-enabled'
            : '#env-temporalAA',
      );
      if (feature === 'cascades') input.value = '3';
      else input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, feature);
    await expect(page.locator('#toast')).toContainText(
      'Could not update lighting',
    );
    expect(await page.evaluate(() => window.caughtForestFramebuffer)).toBe(
      true,
    );
    expect(await history()).toEqual(beforeHistory);
    expect(await save(feature + '-failed')).toEqual(baseline);
    await page.reload();
    await expect(page.locator('#app')).not.toHaveAttribute('inert', {
      timeout: 90000,
    });
    await expect(page.locator('#project-name')).toHaveValue(p.name, {
      timeout: 60000,
    });
    await page.locator('[data-tab=light]').click();
    expect(await save(feature + '-recovered')).toEqual(baseline);
    await page.evaluate((feature) => {
      const input = document.querySelector(
        feature === 'cascades'
          ? '#env-shadowCascades'
          : feature === 'occlusion'
            ? '#env-ao-enabled'
            : '#env-temporalAA',
      );
      if (feature === 'cascades') input.value = '3';
      else input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, feature);
    await expect(page.locator('#preparation-status')).toBeHidden({
      timeout: 60000,
    });
    await expect(page.locator('#toast')).not.toContainText(
      'Could not update lighting',
    );
    await expect(page.locator('#save-state')).toHaveText('Saved locally', {
      timeout: 60000,
    });
    if (feature === 'cascades')
      await expect(page.locator('#env-shadowCascades')).toHaveValue('3');
    else
      await expect(
        page.locator(
          feature === 'occlusion' ? '#env-ao-enabled' : '#env-temporalAA',
        ),
      ).toBeChecked();
    const enabled = await save(feature + '-enabled');
    expect(
      feature === 'cascades'
        ? enabled.environment.shadowCascades
        : feature === 'occlusion'
          ? enabled.environment.ambientOcclusion.enabled
          : enabled.environment.temporalAA,
    ).toBe(feature === 'cascades' ? 3 : true);
    await page.locator('#undo').click();
    expect(await save(feature + '-undo')).toEqual(baseline);
    await page.locator('#redo').click();
    expect(await save(feature + '-redo')).toEqual(enabled);
  }
  const beforeDetail = await save('detail-before');
  await page.evaluate(() => {
    window.rejectForestFramebuffer = true;
    window.caughtForestFramebuffer = false;
    const input = document.querySelector('#env-temporalSharpness');
    input.value = '0.65';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  // Detail is a uniform update: it must reuse the existing GPU resources.
  expect(await page.evaluate(() => window.caughtForestFramebuffer)).toBe(false);
  await page.evaluate(() => {
    window.rejectForestFramebuffer = false;
  });
  const detail = await save('detail-enabled');
  expect(detail.environment.temporalSharpness).toBe(0.65);
  await page.locator('#undo').click();
  expect(await save('detail-undo')).toEqual(beforeDetail);
  await page.locator('#redo').click();
  expect(await save('detail-redo')).toEqual(detail);
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(p.name, {
    timeout: 60000,
  });
  await page.locator('[data-tab=light]').click();
  await page.getByRole('tab', { name: 'View', exact: true }).click();
  await expect(page.locator('#env-temporalSharpness')).toBeVisible();
  await expect(page.locator('#env-temporalSharpness')).toHaveValue('0.65');
  expect(errors).toEqual([]);
});
