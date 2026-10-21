import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createProject, serializeProject } from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';
import { seedEditorProject } from './seed-editor-project.mjs';

async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function capture(page) {
  await page.mouse.move(30, 30);
  const pixels = await page
    .locator('#viewport canvas')
    .evaluate(async (canvas) => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return canvas.toDataURL();
    });
  return createHash('sha256').update(pixels).digest('hex');
}
async function number(page, id, value) {
  await (await inspectorControl(page, '#' + id)).fill(String(value));
  await (await inspectorControl(page, '#' + id)).press('Tab');
}
async function setup(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['Uint8Array', 'Uint32Array']) {
      const Original = window[name];
      window[name] = new Proxy(Original, {
        construct(target, args, constructor) {
          const stage =
            name === 'Uint32Array' && args[0] === 6144
              ? 'picking'
              : name === 'Uint8Array' && args.length === 3 && args[2] === 16900
                ? 'history'
                : undefined;
          if (stage && window.scaleFault === stage) {
            window.scaleFailure = stage;
            throw new RangeError(
              'Injected project settings ' + stage + ' failure',
            );
          }
          return Reflect.construct(target, args, constructor);
        },
      });
    }
  });
  await seedEditorProject(page);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  const project = createProject(64, 64);
  project.heights.fill(2);
  project.holes[0] = 1;
  project.paint[0] = 0.5;
  project.view.water = false;
  project.wind.enabled = false;
  delete project.view.eyeHeight;
  project.foliage = [
    { id: 1, brushId: 'pine', x: -8, z: -8, scale: 1, rotation: 0 },
  ];
  project.props = [
    {
      id: 2,
      model: 'boulder',
      x: 10,
      z: 4,
      yOffset: 1,
      scale: 2,
      rotation: 0,
      cutHole: false,
      holeRadius: 1,
    },
  ];
  project.nextId = 3;
  await page.locator('#file-open').setInputFiles({
    name: 'Project scale.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  await page.locator('#frame').click();
  await page.locator('[data-tab="project"]').click();
  return errors;
}

test('saves first-person eye height, validates edits, and restores it through undo, redo and reload', async ({
  page,
}, info) => {
  const errors = await setup(page);
  await expect(page.locator('#eye-height')).toHaveValue('1.8');
  const original = await save(page, info, 'original');
  const undo = await page.locator('#undo').getAttribute('title');
  await number(page, 'eye-height', 0);
  await expect(page.locator('#toast')).toContainText('eye height must be');
  await expect(page.locator('#eye-height')).toHaveValue('1.8');
  expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
  await page.evaluate(() => (window.scaleFault = 'history'));
  await number(page, 'eye-height', 2.4);
  await expect(page.locator('#toast')).toContainText(
    'previous settings were kept',
  );
  await expect(page.locator('#eye-height')).toHaveValue('1.8');
  expect(await page.evaluate(() => window.scaleFailure)).toBe('history');
  await page.evaluate(() => (window.scaleFault = undefined));
  expect(await save(page, info, 'failed-height')).toEqual(original);
  await number(page, 'eye-height', 2.4);
  expect((await save(page, info, 'tall')).view.eyeHeight).toBe(2.4);
  await page.locator('#undo').click();
  await expect(page.locator('#eye-height')).toHaveValue('1.8');
  await page.locator('#redo').click();
  await expect(page.locator('#eye-height')).toHaveValue('2.4');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await expect(page.locator('#app')).not.toHaveAttribute('inert');
  await page.locator('[data-tab="project"]').click();
  await expect(page.locator('#eye-height')).toHaveValue('2.4');
  await page.screenshot({ path: info.outputPath('project-settings.png') });
  await page.keyboard.press('v');
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await expect(page.locator('#walk-hint')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => !!document.pointerLockElement))
    .toBe(true);
  await page.keyboard.press('v');
  await expect
    .poll(() => page.evaluate(() => !!document.pointerLockElement))
    .toBe(false);
  expect(errors).toEqual([]);
});

test('resizes existing sculpting atomically, preserves edits and scenery, and recovers failure and cancellation', async ({
  page,
}, info) => {
  const errors = await setup(page);
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#redo')).toBeEnabled();
  const original = await save(page, info, 'before-resize');
  const image = await capture(page);
  const undo = await page.locator('#undo').getAttribute('title');
  const redo = await page.locator('#redo').getAttribute('title');
  await number(page, 'terrain-size', 128);
  await expect(page.locator('#terrain-size-preview')).toHaveText(
    '64 × 64 cells · 128 × 128 m · 2 m/cell',
  );
  for (const stage of ['picking', 'history']) {
    await page.evaluate((stage) => {
      window.scaleFault = stage;
      window.scaleFailure = undefined;
    }, stage);
    await (await inspectorControl(page, '#resize-terrain')).click();
    await expect(page.locator('#toast')).toContainText(
      'previous scene was kept',
    );
    expect(await page.evaluate(() => window.scaleFailure)).toBe(stage);
    expect(await capture(page)).toBe(image);
    expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
    expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
    await page.evaluate(() => (window.scaleFault = undefined));
    expect(await save(page, info, stage + '-failed')).toEqual(original);
  }
  await page.evaluate(() => {
    document.querySelector('#resize-terrain').click();
    document.querySelector('#cancel-preparation').click();
  });
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, info, 'cancelled')).toEqual(original);
  expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
  await (await inspectorControl(page, '#resize-terrain')).click();
  await expect(page.locator('#toast')).toContainText('Terrain resized.');
  const resized = await save(page, info, 'resized');
  expect(resized.size).toBe(128);
  expect(resized.resolution).toBe(64);
  expect(resized.heights).toEqual(original.heights.map((v) => v * 2));
  expect(resized.paint).toEqual(original.paint);
  expect(resized.holes).toEqual(original.holes);
  expect(resized.foliage).toEqual(
    original.foliage.map((p) => ({ ...p, x: p.x * 2, z: p.z * 2 })),
  );
  expect(resized.props).toEqual(
    original.props.map((p) => ({ ...p, x: p.x * 2, z: p.z * 2 })),
  );
  await expect(page.locator('#size-label')).toHaveText('128 × 128 m');
  await expect(page.locator('#spacing-label')).toHaveText('2 m');
  await page.locator('#undo').click();
  await expect(page.locator('#terrain-size')).toHaveValue('64');
  expect(await save(page, info, 'resize-undone')).toEqual(original);
  await page.locator('#redo').click();
  await expect(page.locator('#terrain-size')).toHaveValue('128');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false, {
    timeout: 30000,
  });
  await expect(page.locator('#size-label')).toHaveText('128 × 128 m');
  await page.locator('[data-tab="project"]').click();
  await number(page, 'terrain-size', 256);
  await (await inspectorControl(page, '#scale-elevation')).uncheck();
  await (await inspectorControl(page, '#resize-terrain')).click();
  await expect(page.locator('#toast')).toContainText('Terrain resized.');
  expect((await save(page, info, 'horizontal-resize')).heights).toEqual(
    resized.heights,
  );
  expect(errors).toEqual([]);
});

test('shows physical size with resolution before generating a 512-cell terrain', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const errors = await setup(page);
  await page.locator('[data-tab="sculpt"]').click();
  await (await inspectorControl(page, '#resolution')).selectOption('512');
  await number(page, 'generate-size', 512);
  await expect(page.locator('#generation-metrics')).toHaveText(
    '512 × 512 cells · 512 × 512 m · 1 m/cell',
  );
  await (await inspectorControl(page, '#preset')).selectOption('flat');
  await (await inspectorControl(page, '#generate')).click();
  await expect(page.locator('#toast')).toContainText('Landscape generated.', {
    timeout: 30000,
  });
  await expect(page.locator('#resolution-label')).toHaveText('512 × 512');
  await expect(page.locator('#size-label')).toHaveText('512 × 512 m');
  await expect(page.locator('#spacing-label')).toHaveText('1 m');
  await page.locator('#frame').click();
  await page.screenshot({ path: info.outputPath('512-cells-512-metres.png') });
  const saved = await save(page, info, '512-terrain');
  expect(saved.size).toBe(512);
  expect(saved.resolution).toBe(512);
  await page.locator('#undo').click();
  await expect(page.locator('#size-label')).toHaveText('64 × 64 m');
  await expect(page.locator('#resolution-label')).toHaveText('64 × 64');
  expect(errors).toEqual([]);
});
