import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createProject,
  generateTerrain,
  serializeProject,
} from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';

async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function capture(page) {
  await page.mouse.move(50, 30);
  return page.locator('#viewport canvas').evaluate(async (canvas) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return canvas.toDataURL();
  });
}
async function arm(page, stage) {
  await page.evaluate((stage) => {
    window.erosionFault = stage;
    window.lastErosionFault = undefined;
  }, stage);
}

test('erosion retains the committed landscape through preview, cancellation and apply failures, then retries', async ({
  page,
}, info) => {
  test.setTimeout(120000);
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
    for (const name of ['Float32Array', 'Uint32Array', 'Uint8Array']) {
      const Original = window[name];
      window[name] = new Proxy(Original, {
        construct(target, args, constructor) {
          let stage;
          const n = args[0];
          if (name === 'Float32Array' && n === 3267)
            stage = /\/assets\/rapier-[\w-]+\.js/.test(new Error().stack)
              ? 'collision'
              : 'terrain';
          if (name === 'Uint32Array' && n === 6144) stage = 'picking';
          if (name === 'Uint8Array' && args.length === 3 && args[2] === 16900)
            stage = 'history';
          if (
            name === 'Float32Array' &&
            typeof n === 'number' &&
            n >= 16 &&
            n % 16 === 0 &&
            n !== 288 &&
            /\/assets\/terrain-scene-[\w-]+\.js/.test(new Error().stack)
          )
            stage = 'foliage';
          if (stage && stage === window.erosionFault) {
            window.lastErosionFault = stage;
            throw new RangeError('Injected erosion ' + stage + ' failure');
          }
          return Reflect.construct(target, args, constructor);
        },
      });
    }
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const project = createProject(64, 64);
  generateTerrain(project, 'alpine');
  project.name = 'Erosion recovery baseline';
  project.view.textureResolution = 256;
  project.view.water = false;
  project.wind.enabled = false;
  project.foliage = [
    { id: 1, brushId: 'grass', x: 0, z: 0, scale: 1, rotation: 0 },
    { id: 2, brushId: 'grass', x: 2, z: 0, scale: 1, rotation: 0 },
  ];
  project.props = [
    {
      id: 3,
      model: 'platform',
      x: 2,
      z: 2,
      yOffset: 1,
      scale: 1,
      rotation: 0,
      cutHole: false,
      holeRadius: 3,
    },
    {
      id: 4,
      model: 'portal',
      x: -12,
      z: -10,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 3,
    },
  ];
  project.holes[20 * 64 + 20] = 1;
  project.nextId = 5;
  await page.locator('#file-open').setInputFiles({
    name: 'erosion-recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('#frame').click();
  await page.locator('#physics').click();
  await expect(page.locator('#physics-state')).toHaveText(
    'Terrain collision active',
  );
  await (await inspectorControl(page, '[data-tool="raise"]')).click();
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await expect(page.locator('#redo')).toBeEnabled();
  const before = await save(page, info, 'baseline');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const pixels = await capture(page),
    undo = await page.locator('#undo').getAttribute('title'),
    redo = await page.locator('#redo').getAttribute('title');
  const panel = page.locator('#erosion-dialog'),
    status = panel.locator('#erosion-status');
  const unchanged = async () => {
    expect(await capture(page)).toBe(pixels);
    expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
    expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
    await expect(panel.locator('#erosion-original')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  };
  const calculate = async () => {
    await panel.locator('[name=mode]').selectOption('thermal');
    await panel.locator('[name=thermalIterations]').fill('24');
    await panel.locator('[name=talus]').fill('4');
    await panel.locator('#erosion-preview').click();
  };
  await (await inspectorControl(page, '#weather-landscape')).click();
  // A worker result must not become an uncaught error if its first display fails.
  await arm(page, 'terrain');
  await calculate();
  await expect(status).toContainText('Could not display preview', {
    timeout: 30000,
  });
  await unchanged();
  expect(await page.evaluate(() => window.lastErosionFault)).toBe('terrain');
  await arm(page, undefined);
  await panel.locator('#erosion-result').click();
  await expect(status).toContainText('Preview ready');
  expect(await capture(page)).not.toBe(pixels);
  const evidence = [
    { stage: 'initial-worker-result', restoredPixelsAndHistory: true },
  ];
  for (const stage of ['terrain', 'picking', 'foliage']) {
    await panel.locator('#erosion-original').click();
    await arm(page, stage);
    await panel.locator('#erosion-result').click();
    await expect(status).toContainText('Could not display preview');
    await unchanged();
    expect(await page.evaluate(() => window.lastErosionFault)).toBe(stage);
    await arm(page, undefined);
    await panel.locator('#erosion-result').click();
    await expect(status).toContainText('Preview ready');
    expect(await capture(page)).not.toBe(pixels);
    evidence.push({
      stage,
      restoredPixelsAndHistory: true,
      retrySucceeded: true,
    });
  }
  for (const stage of ['collision', 'history']) {
    await arm(page, stage);
    await panel.locator('#erosion-apply').click();
    await expect(status).toContainText('Could not apply');
    await unchanged();
    expect(await page.evaluate(() => window.lastErosionFault)).toBe(stage);
    await arm(page, undefined);
    await panel.locator('#erosion-result').click();
    await expect(status).toContainText('Preview ready');
    evidence.push({
      stage,
      restoredPixelsAndHistory: true,
      retrySucceeded: true,
    });
  }
  // Cancelling a visible preview must use retained resources while construction stays broken.
  await arm(page, 'terrain');
  await panel.locator('#erosion-cancel').click();
  await expect(panel).not.toBeAttached();
  expect(await capture(page)).toBe(pixels);
  expect(await page.evaluate(() => window.lastErosionFault)).toBeUndefined();
  await arm(page, undefined);
  expect(await save(page, info, 'cancelled-after-failures')).toEqual(before);
  expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(redo);

  await (await inspectorControl(page, '#weather-landscape')).click();
  await calculate();
  await expect(status).toContainText('Preview ready');
  // Invalidating settings also restores the original without building another scene.
  await arm(page, 'terrain');
  await panel.locator('[name=talus]').fill('5');
  await expect(panel.locator('#erosion-apply')).toBeDisabled();
  await unchanged();
  expect(await page.evaluate(() => window.lastErosionFault)).toBeUndefined();
  await arm(page, undefined);
  await panel.locator('#erosion-preview').click();
  await expect(status).toContainText('Preview ready');
  await page.screenshot({
    path: info.outputPath('erosion-preview.png'),
    fullPage: true,
  });
  // Apply works while viewing Original; failed preparation above has not consumed redo.
  await panel.locator('#erosion-original').click();
  await unchanged();
  await panel.locator('#erosion-apply').click();
  await expect(panel).not.toBeAttached();
  await expect(page.locator('#toast')).toContainText('Erosion applied');
  await expect(page.locator('#redo')).toBeDisabled();
  const after = await save(page, info, 'applied');
  expect(after.heights).not.toEqual(before.heights);
  expect(after.erosion).toMatchObject({
    mode: 'thermal',
    thermalIterations: 24,
    talus: 5,
  });
  for (const key of [
    'holes',
    'paint',
    'foliage',
    'props',
    'materials',
    'assets',
  ])
    expect(after[key]).toEqual(before[key]);
  await page.locator('#undo').click();
  expect(await save(page, info, 'undone')).toEqual(before);
  await page.locator('#redo').click();
  expect(await save(page, info, 'redone')).toEqual(after);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(after.name);
  expect(await save(page, info, 'reopened')).toEqual(after);
  expect(errors).toEqual([]);
  await writeFile(
    info.outputPath('erosion-recovery.json'),
    JSON.stringify(
      {
        evidence,
        cancellationWhileAllocationFails: true,
        settingsInvalidationWhileAllocationFails: true,
        appliedFromOriginalComparison: true,
        nativeUndoRedoAutosave: true,
        errors,
      },
      null,
      2,
    ),
  );
});
