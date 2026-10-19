import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProject,
  generateTerrain,
  serializeProject,
  environmentPreset,
  decodeHeightmapPNG,
} from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';
import { exrFixture } from '../fixtures/environment-exr.ts';

async function set(page, id, value) {
  await page.locator('#' + id).evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
}
async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function pixels(page) {
  await page.mouse.move(50, 32);
  return page.locator('#viewport canvas').evaluate(async (canvas) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return canvas.toDataURL();
  });
}
async function brightness(page) {
  const png = await page.locator('#viewport canvas').screenshot();
  const map = await decodeHeightmapPNG(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
  );
  return map.values.reduce((sum, v) => sum + v, 0) / map.values.length;
}
async function autosave(page) {
  const bytes = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('terrain-studio', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const blob = await new Promise((resolve, reject) => {
        const req = db
          .transaction('projects')
          .objectStore('projects')
          .get('autosave');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return [...new Uint8Array(await blob.arrayBuffer())];
    } finally {
      db.close();
    }
  });
  return decodeDocument(Buffer.from(bytes));
}
async function setup(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /THREE|Shader|WebGL/i.test(message.text())
    )
      errors.push(message.text());
  });
  await page.addInitScript(() => {
    const original = Uint8Array;
    window.Uint8Array = new Proxy(original, {
      construct(target, args, constructor) {
        if (
          window.daylightFault === 'history' &&
          args.length === 3 &&
          args[2] === 16900
        ) {
          window.daylightFault = undefined;
          window.caughtDaylightFault = 'history';
          throw new RangeError('Injected daylight history failure');
        }
        return Reflect.construct(target, args, constructor);
      },
    });
    const textures = new Set();
    window.daylightTextures = textures;
    for (const api of [
      WebGLRenderingContext.prototype,
      WebGL2RenderingContext.prototype,
    ]) {
      const draw = api.drawElements,
        create = api.createTexture,
        dispose = api.deleteTexture;
      api.drawElements = function (...args) {
        if (window.daylightFault === 'capture') {
          window.daylightFault = undefined;
          window.caughtDaylightFault = 'capture';
          throw new Error('Injected daylight capture failure');
        }
        return Reflect.apply(draw, this, args);
      };
      api.createTexture = function (...args) {
        const value = Reflect.apply(create, this, args);
        textures.add(value);
        return value;
      };
      api.deleteTexture = function (texture) {
        textures.delete(texture);
        return Reflect.apply(dispose, this, [texture]);
      };
    }
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const project = createProject(64, 64);
  generateTerrain(project, 'island');
  project.name = 'Daylight verification';
  project.wind.enabled = false;
  project.view.water = false;
  project.view.textureResolution = 256;
  project.environment = environmentPreset('daylight');
  project.foliage = [
    { id: 1, brushId: 'pine', x: 0, z: 0, scale: 2, rotation: 0 },
  ];
  project.nextId = 2;
  await page.locator('#file-open').setInputFiles({
    name: 'daylight.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('[data-tab=light]').click();
  await page.locator('#frame').click();
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  return errors;
}

test('authors atmospheric times, plays without history churn, pauses, exports and restores the cycle', async ({
  page,
  context,
}, info) => {
  test.setTimeout(150000);
  const errors = await setup(page);
  await (await inspectorControl(page, '#daylight-enabled')).check();
  await expect(page.locator('#daylight-time')).toHaveValue('12:00');
  await expect(page.locator('#env-sunAzimuth')).toHaveCount(0);
  const day = await brightness(page);
  await page.screenshot({ path: info.outputPath('noon.png') });
  await page.locator('[data-solar-hour="0"]').click();
  await expect(page.locator('#daylight-time')).toHaveValue('00:00');
  const night = await brightness(page);
  expect(day).toBeGreaterThan(night + 0.1);
  await page.screenshot({ path: info.outputPath('night.png') });
  await set(page, 'daylight-time', '18:30');
  await page.screenshot({ path: info.outputPath('evening.png') });
  await page.getByText('Sun path & atmosphere', { exact: true }).click();
  await set(page, 'daylight-latitude', 0);
  await (await inspectorControl(page, '#daylight-season')).selectOption('80');
  await set(page, 'daylight-northOffset', 90);
  await set(page, 'daylight-dayLengthMinutes', 0.25);
  await set(page, 'daylight-time', '06:00');
  await expect(page.locator('#daylight-status')).toContainText('180.');
  const beforePlay = await save(page, info, 'authored');
  await (await inspectorControl(page, '#daylight-play')).click();
  await expect(page.locator('#daylight-play')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const undo = await page.locator('#undo').getAttribute('title');
  await expect(page.locator('#daylight-time')).not.toHaveValue('06:00');
  const playing = await save(page, info, 'playing');
  const textureCount = await page.evaluate(() => window.daylightTextures.size);
  const clock = await page.locator('#daylight-time').inputValue();
  await expect
    .poll(async () => {
      const now = await page.locator('#daylight-time').inputValue();
      const [h, m] = now.split(':').map(Number),
        [beforeH, beforeM] = clock.split(':').map(Number);
      return (h * 60 + m - beforeH * 60 - beforeM + 1440) % 1440;
    })
    .toBeGreaterThan(240);
  expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
  expect(await autosave(page)).toEqual(playing);
  expect(await page.evaluate(() => window.daylightTextures.size)).toBe(
    textureCount,
  );
  await (await inspectorControl(page, '#daylight-play')).click();
  await expect(page.locator('#daylight-play')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const paused = await save(page, info, 'paused');
  expect(paused.environment.timeOfDay.playing).toBe(false);
  expect(paused.environment.timeOfDay.hour).not.toBe(
    beforePlay.environment.timeOfDay.hour,
  );
  await page.locator('#undo').click();
  await expect(page.locator('#daylight-play')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.locator('#redo').click();
  await expect(page.locator('#daylight-play')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(await save(page, info, 'redone')).toEqual(paused);
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(paused.name);
  await page.locator('[data-tab=light]').click();
  expect(await save(page, info, 'reloaded')).toEqual(paused);
  const download = page.waitForEvent('download');
  await page.locator('#export').click();
  const path = info.outputPath('daylight.glb');
  await (await download).saveAs(path);
  await page.locator('#file-open').setInputFiles(path);
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  expect(await save(page, info, 'glb-restored')).toEqual(paused);
  const runtime = await context.newPage();
  runtime.on('pageerror', (error) => errors.push(error.message));
  runtime.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /THREE|Shader|WebGL/i.test(message.text())
    )
      errors.push(message.text());
  });
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances');
  await runtime.locator('#open-project').setInputFiles(path);
  await expect(runtime.locator('#status')).toContainText(
    'Daylight verification',
  );
  await expect(runtime.locator('#lighting')).toContainText('Dynamic sky');
  await runtime.screenshot({ path: info.outputPath('runtime.png') });
  await runtime
    .locator('#open-project')
    .setInputFiles(info.outputPath('playing.terrain'));
  await expect(runtime.locator('#status')).toContainText(
    'Daylight verification',
  );
  const runtimePixels = () =>
    runtime.locator('#stage canvas').evaluate(async (canvas) => {
      await new Promise(requestAnimationFrame);
      return canvas.toDataURL();
    });
  const first = await runtimePixels();
  await expect.poll(runtimePixels).not.toBe(first);
  await runtime.close();
  expect(errors).toEqual([]);
});

test('failed GPU sky capture or history preparation preserves pixels, resources and redo, then retries', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const errors = await setup(page);
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(
    'Daylight verification',
  );
  const baseline = await save(page, info, 'baseline');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const originalPixels = await pixels(page),
    undo = await page.locator('#undo').getAttribute('title');
  const originalTextures = await page.evaluate(
    () => window.daylightTextures.size,
  );
  for (const stage of ['capture', 'history']) {
    await page.evaluate((stage) => {
      window.daylightFault = stage;
      const input = document.querySelector('#daylight-enabled');
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, stage);
    await expect(page.locator('#toast')).toContainText(
      'Could not update lighting',
    );
    await expect(page.locator('#daylight-enabled')).not.toBeChecked();
    expect(await page.evaluate(() => window.caughtDaylightFault)).toBe(stage);
    expect(await pixels(page)).toBe(originalPixels);
    expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
    await expect(page.locator('#redo')).toBeEnabled();
    expect(await autosave(page)).toEqual(baseline);
    expect(await save(page, info, stage + '-failed')).toEqual(baseline);
    expect(await page.evaluate(() => window.daylightTextures.size)).toBe(
      originalTextures,
    );
  }
  await (await inspectorControl(page, '#daylight-enabled')).check();
  await expect(page.locator('#daylight-time')).toBeVisible();
  const enabled = await save(page, info, 'retried');
  expect(enabled.environment.timeOfDay.enabled).toBe(true);
  await page.locator('#undo').click();
  await expect(page.locator('#daylight-enabled')).not.toBeChecked();
  expect(await save(page, info, 'undone')).toEqual(baseline);
  await page.locator('#redo').click();
  await expect(page.locator('#daylight-enabled')).toBeChecked();
  expect(await save(page, info, 'redone')).toEqual(enabled);
  const activePixels = await pixels(page),
    activeTextures = await page.evaluate(() => window.daylightTextures.size);
  for (const stage of ['capture', 'history']) {
    await page.evaluate((stage) => {
      window.daylightFault = stage;
      document.querySelector('[data-solar-hour="0"]').click();
    }, stage);
    await expect(page.locator('#toast')).toContainText(
      'Could not update lighting',
    );
    expect(await page.evaluate(() => window.caughtDaylightFault)).toBe(stage);
    expect(await pixels(page)).toBe(activePixels);
    expect(await save(page, info, 'active-' + stage)).toEqual(enabled);
    expect(await autosave(page)).toEqual(enabled);
    expect(await page.evaluate(() => window.daylightTextures.size)).toBe(
      activeTextures,
    );
  }
  await page.locator('[data-solar-hour="0"]').click();
  await expect(page.locator('#daylight-time')).toHaveValue('00:00');
  await page.locator('#undo').click();
  expect(await save(page, info, 'active-retry-undone')).toEqual(enabled);
  expect(errors).toEqual([]);
});

test('switches between an animated sky and retained EXR illumination, with recovery and manual presets', async ({
  page,
}, info) => {
  const errors = await setup(page);
  await (await inspectorControl(page, '#daylight-enabled')).check();
  await (await inspectorControl(page, '#daylight-play')).click();
  const bytes = Buffer.from(await exrFixture());
  await page.locator('#environment-open').setInputFiles({
    name: 'Evening.exr',
    mimeType: 'image/x-exr',
    buffer: bytes,
  });
  await expect(page.locator('#toast')).toHaveText('Environment imported.');
  await expect(page.locator('#daylight-enabled')).not.toBeChecked();
  await expect(page.locator('#env-mode')).toHaveValue('image');
  const imported = await save(page, info, 'exr');
  expect(imported.environment.timeOfDay.playing).toBe(false);
  await (await inspectorControl(page, '#daylight-enabled')).check();
  const dynamic = await save(page, info, 'dynamic');
  expect(dynamic.environment.image).toEqual(imported.environment.image);
  await page.locator('#environment-open').setInputFiles({
    name: 'Broken.exr',
    mimeType: 'image/x-exr',
    buffer: bytes.subarray(0, -8),
  });
  await expect(page.locator('#toast')).toContainText(
    'Could not import environment',
  );
  await expect(page.locator('#daylight-enabled')).toBeChecked();
  expect(await save(page, info, 'after-broken')).toEqual(dynamic);
  await (await inspectorControl(page, '#env-mode')).selectOption('image');
  await expect(page.locator('#daylight-enabled')).not.toBeChecked();
  expect((await save(page, info, 'image-again')).environment.image).toEqual(
    imported.environment.image,
  );
  await page.locator('#undo').click();
  expect(await save(page, info, 'undone')).toEqual(dynamic);
  await (
    await inspectorControl(page, '#environment-preset')
  ).selectOption('daylight');
  await expect(page.locator('#env-sunElevation')).toBeVisible();
  await expect(page.locator('#daylight-enabled')).not.toBeChecked();
  expect((await save(page, info, 'preset')).environment.image).toEqual(
    imported.environment.image,
  );
  expect(errors).toEqual([]);
});
