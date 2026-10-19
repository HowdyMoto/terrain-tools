import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createProject,
  defaultWaterSettings,
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
async function setup(page, info, water = false) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of [
      'Float32Array',
      'Uint32Array',
      'Uint8Array',
      'Int32Array',
    ]) {
      const Original = window[name];
      window[name] = new Proxy(Original, {
        construct(target, args, constructor) {
          const n = args[0];
          let stage;
          if (name === 'Int32Array' && n === 4096) stage = 'water';
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
          if (stage && window.strokeProbe)
            window.strokeProbe[stage] = (window.strokeProbe[stage] ?? 0) + 1;
          const fault = window.strokeFault;
          if (fault && stage === fault.stage && ++fault.calls >= fault.failAt) {
            window.lastStrokeFault = { ...fault };
            if (!fault.persistent) window.strokeFault = undefined;
            throw new RangeError('Injected stroke ' + stage + ' failure');
          }
          return Reflect.construct(target, args, constructor);
        },
      });
    }
    addEventListener(
      'pointerdown',
      (event) => {
        window.lastStrokePointer = event.pointerId;
      },
      true,
    );
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const p = createProject(64, 64);
  generateTerrain(p, 'flat');
  p.name = 'Stroke baseline';
  p.view.textureResolution = 256;
  p.view.water = false;
  p.wind.enabled = false;
  if (water) {
    p.water = defaultWaterSettings(p);
    p.water.ocean.enabled = true;
    p.water.seaLevel = 0.2;
    Object.assign(p.water.ocean.surface, { speed: 0, caustics: 0, wetness: 0 });
  }
  p.foliage = [
    { id: 1, brushId: 'grass', x: 0, z: 0, scale: 1, rotation: 0 },
    { id: 2, brushId: 'grass', x: 2, z: 0, scale: 1, rotation: 0 },
  ];
  p.props = [
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
  ];
  p.nextId = 4;
  await page.locator('#file-open').setInputFiles({
    name: 'stroke.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(p)),
  });
  await expect(page.locator('#project-name')).toHaveValue(p.name);
  await page.locator('#frame').click();
  await page.locator('#physics').click();
  await expect(page.locator('#physics-state')).toHaveText(
    'Terrain collision active',
  );
  await (await inspectorControl(page, '[data-tool="raise"]')).click();
  await page.locator('#project-name').fill('Future name');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(p.name);
  await expect(page.locator('#redo')).toBeEnabled();
  const baseline = await save(page, info, 'baseline');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  return { baseline, errors };
}
async function start(page, foliage = false) {
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.evaluate(() => {
    window.strokeProbe = {};
  });
  await page.mouse.down();
  if (foliage === 'erase')
    await expect(page.locator('#foliage-detail-stats')).toContainText(
      '0 plants selected',
    );
  else if (foliage)
    await expect
      .poll(async () =>
        parseInt(await page.locator('#foliage-detail-stats').textContent(), 10),
      )
      .toBeGreaterThan(2);
  else
    await expect
      .poll(() => page.evaluate(() => window.strokeProbe.terrain ?? 0))
      .toBeGreaterThan(0);
}
async function arm(page, stage, persistent = true) {
  await page.evaluate(
    ({ stage, persistent }) => {
      window.lastStrokeFault = undefined;
      window.strokeFault = { stage, failAt: 1, calls: 0, persistent };
    },
    { stage, persistent },
  );
}
async function capture(page) {
  await page.mouse.move(50, 30);
  return page.locator('#viewport canvas').evaluate(async (canvas) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return canvas.toDataURL();
  });
}

test('water flooding runs at stroke completion and failures restore rendered water, history and saved data', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { baseline, errors } = await setup(page, info, true);
  const originalPixels = await capture(page);
  const undo = await page.locator('#undo').getAttribute('title');
  const redo = await page.locator('#redo').getAttribute('title');
  for (const stage of ['water', 'history']) {
    await start(page);
    await expect
      .poll(() => page.evaluate(() => window.strokeProbe.terrain ?? 0))
      .toBeGreaterThan(3);
    expect(await page.evaluate(() => window.strokeProbe.water ?? 0)).toBe(0);
    await arm(page, stage);
    await page.mouse.up();
    await expect(page.locator('#toast')).toContainText(
      'The previous terrain was restored',
    );
    expect(await page.evaluate(() => window.lastStrokeFault.stage)).toBe(stage);
    // Recovery must not repeat preparation, even while the fault remains armed.
    expect(await capture(page)).toBe(originalPixels);
    expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
    expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
    await page.evaluate(() => {
      window.strokeFault = undefined;
    });
    expect(await save(page, info, stage + '-water-failed')).toEqual(baseline);
  }
  await start(page);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await capture(page)).toBe(originalPixels);
  expect(await save(page, info, 'water-cancelled')).toEqual(baseline);
  await start(page);
  await page.mouse.up();
  expect(await page.evaluate(() => window.strokeProbe.water)).toBe(1);
  const after = await save(page, info, 'water-retry');
  expect(after.heights.some((height) => height > 0)).toBe(true);
  await expect(page.locator('#redo')).toBeDisabled();
  await page.locator('#undo').click();
  expect(await save(page, info, 'water-undone')).toEqual(baseline);
  await page.locator('#redo').click();
  expect(await save(page, info, 'water-redone')).toEqual(after);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(after.name);
  expect(await save(page, info, 'water-reopened')).toEqual(after);
  expect(errors).toEqual([]);
});
test('failed live previews and final collision preparation restore pixels, data, redo and editability', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { baseline, errors } = await setup(page, info);
  const originalPixels = await capture(page),
    undo = await page.locator('#undo').getAttribute('title'),
    redo = await page.locator('#redo').getAttribute('title');
  const evidence = [];
  for (const stage of ['terrain', 'picking', 'collision', 'history']) {
    await start(page);
    await expect(page.locator('#active-tool kbd')).toHaveText('Esc cancels');
    if (stage === 'terrain')
      await page.screenshot({
        path: info.outputPath('active-stroke.png'),
        fullPage: true,
      });
    await expect(page.locator('#undo')).toHaveAttribute('title', undo);
    await expect(page.locator('#redo')).toHaveAttribute('title', redo);
    await arm(page, stage);
    if (stage === 'collision' || stage === 'history') await page.mouse.up();
    await expect(page.locator('#toast')).toContainText(
      'The previous terrain was restored',
    );
    await page.mouse.up();
    // Keep the failure armed while comparing: rollback must not need another rebuild.
    expect(await capture(page)).toBe(originalPixels);
    const fault = await page.evaluate(() => window.lastStrokeFault);
    expect(fault.stage).toBe(stage);
    expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
    expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
    await page.evaluate(() => {
      window.strokeFault = undefined;
    });
    expect(await save(page, info, stage + '-failed')).toEqual(baseline);
    evidence.push({
      stage,
      restoredPixels: true,
      restoredDocument: true,
      historyUnchanged: true,
      faultCalls: fault.calls,
    });
  }
  // A successful stroke makes one undo entry and replaces the former redo branch.
  await start(page);
  await page.mouse.up();
  const after = await save(page, info, 'successful');
  expect(after.heights.some((height) => height > 0)).toBe(true);
  await expect(page.locator('#redo')).toBeDisabled();
  await page.locator('#undo').click();
  expect(await save(page, info, 'undone')).toEqual(baseline);
  await page.locator('#redo').click();
  expect(await save(page, info, 'redone')).toEqual(after);
  // Native autosave must also preserve the completed stroke.
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(after.name);
  expect(await save(page, info, 'reopened')).toEqual(after);
  // A save timer already queued before the stroke must publish the committed document.
  const queued = { ...after, name: 'Pending autosave baseline' };
  await page.locator('#project-name').fill(queued.name);
  await page.locator('#project-name').press('Tab');
  await start(page);
  await expect(page.locator('#save-state')).toHaveText('Saving…');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const savedDuringStroke = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('terrain-studio', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const blob = await new Promise((resolve, reject) => {
      const request = db
        .transaction('projects', 'readonly')
        .objectStore('projects')
        .get('autosave');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  expect(decodeDocument(Buffer.from(savedDuringStroke))).toEqual(queued);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await save(page, info, 'cancelled-after-autosave')).toEqual(queued);
  await writeFile(
    info.outputPath('stroke-recovery.json'),
    JSON.stringify(evidence, null, 2),
  );
  expect(errors).toEqual([]);
});
test('Escape and pointer cancellation restore hole, surface and foliage strokes and preserve redo', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { errors } = await setup(page, info);
  for (const mode of ['hole', 'material', 'foliage', 'erase']) {
    if (mode === 'material') {
      await page.locator('[data-tab="materials"]').click();
      await page.locator('[data-material="1"]').click();
    } else if (mode === 'foliage' || mode === 'erase') {
      await page.locator('[data-tab="foliage"]').click();
      await (await inspectorControl(page, '#brush-select')).selectOption('1');
      if (mode === 'erase')
        await (await inspectorControl(page, '#erase-foliage')).click();
    } else await (await inspectorControl(page, '[data-tool="hole"]')).click();
    const baseline = await save(page, info, mode + '-before'),
      pixels = await capture(page),
      undo = await page.locator('#undo').getAttribute('title'),
      redo = await page.locator('#redo').getAttribute('title');
    await start(page, mode === 'erase' ? 'erase' : mode === 'foliage');
    if (mode === 'material')
      await page.locator('#viewport canvas').evaluate((canvas) =>
        canvas.dispatchEvent(
          new PointerEvent('pointercancel', {
            pointerId: window.lastStrokePointer,
            isPrimary: true,
          }),
        ),
      );
    else await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await capture(page)).toBe(pixels);
    expect(await save(page, info, mode + '-cancelled')).toEqual(baseline);
    expect(await page.locator('#undo').getAttribute('title')).toBe(undo);
    expect(await page.locator('#redo').getAttribute('title')).toBe(redo);
  }
  // Fail before the first foliage preview, then retry a complete paint stroke.
  await (await inspectorControl(page, '#erase-foliage')).click();
  const baseline = await save(page, info, 'foliage-fault-before');
  await arm(page, 'foliage', true);
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await expect(page.locator('#toast')).toContainText(
    'The previous terrain was restored',
  );
  await page.evaluate(() => {
    window.strokeFault = undefined;
  });
  expect(await save(page, info, 'foliage-fault-after')).toEqual(baseline);
  await start(page, true);
  await page.mouse.up();
  expect(
    (await save(page, info, 'foliage-retry')).foliage.length,
  ).toBeGreaterThan(baseline.foliage.length);
  expect(errors).toEqual([]);
});
