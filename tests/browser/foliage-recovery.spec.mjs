import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createProject,
  generateTerrain,
  serializeProject,
  foliageModels,
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
async function range(page, id, value) {
  await page.locator('#' + id).evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function number(page, id, value) {
  await (await inspectorControl(page, '#' + id)).fill(String(value));
  await (await inspectorControl(page, '#' + id)).press('Tab');
}
async function arm(page, stage, failAt = 1) {
  await page.evaluate(
    ({ stage, failAt }) => {
      window.foliageFault = stage ? { stage, failAt, calls: 0 } : undefined;
      window.lastFoliageFault = undefined;
    },
    { stage, failAt },
  );
}
async function setup(page, info, mixed = false) {
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
    const fail = (stage) => {
      const fault = window.foliageFault;
      if (fault && stage === fault.stage && ++fault.calls >= fault.failAt) {
        window.lastFoliageFault = { ...fault };
        throw new RangeError('Injected foliage ' + stage + ' failure');
      }
    };
    for (const name of ['Float32Array', 'Uint8Array']) {
      const Original = window[name];
      window[name] = new Proxy(Original, {
        construct(target, args, constructor) {
          const n = args[0];
          if (
            name === 'Float32Array' &&
            typeof n === 'number' &&
            n >= 16 &&
            n % 16 === 0 &&
            n !== 288 &&
            /\/assets\/terrain-scene-[\w-]+\.js/.test(new Error().stack)
          )
            fail('buffers');
          if (name === 'Uint8Array' && args.length === 3 && args[2] === 16900)
            fail('history');
          return Reflect.construct(target, args, constructor);
        },
      });
    }
    const push = Array.prototype.push;
    Array.prototype.push = function (...items) {
      if (
        items.some(
          (value) =>
            value &&
            value.brushId === 'pine' &&
            value.id >= 5 &&
            typeof value.x === 'number' &&
            typeof value.z === 'number',
        )
      )
        fail('population');
      return Reflect.apply(push, this, items);
    };
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const project = createProject(64, 64);
  generateTerrain(project, 'flat');
  project.name = mixed ? 'Mixed foliage recovery' : 'Legacy foliage recovery';
  project.view.water = false;
  project.view.textureResolution = 256;
  project.wind.enabled = false;
  const brush = project.brushes[0];
  Object.assign(brush, {
    model: 'grass',
    density: 0.03,
    minWeight: 0.05,
    maxSlope: 90,
    spacing: 2,
    materials: project.materials.map((layer) => layer.id),
  });
  if (mixed) {
    const primary = foliageModels(brush)[0];
    brush.models = [
      {
        ...primary,
        minScale: 0.6,
        maxScale: 1.4,
        flexibility: { source: 'height', start: 0.1, end: 1, exponent: 2 },
        lods: [{ model: 'grass-low', distance: 180, density: 1 }],
      },
      {
        ...primary,
        id: 'stones',
        model: 'boulder',
        weight: 1,
        minScale: 0.5,
        maxScale: 0.8,
        wind: 0,
        crush: 0,
      },
    ];
  }
  project.foliage = [
    {
      id: 1,
      brushId: 'pine',
      x: -4,
      z: 0,
      scale: 1,
      rotation: 0,
      ...(mixed ? { modelId: 'primary' } : {}),
    },
    {
      id: 2,
      brushId: 'pine',
      x: 0,
      z: 0,
      scale: 1,
      rotation: 0,
      ...(mixed ? { modelId: 'stones' } : {}),
    },
    { id: 3, brushId: 'grass', x: 10, z: 0, scale: 1, rotation: 0 },
    { id: 4, brushId: 'grass', x: 14, z: 0, scale: 1, rotation: 0 },
  ];
  project.nextId = 5;
  await page.locator('#file-open').setInputFiles({
    name: 'foliage-recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('#frame').click();
  await page.locator('[data-tab="foliage"]').click();
  await (await inspectorControl(page, '#brush-select')).selectOption('0');
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await expect(page.locator('#redo')).toBeEnabled();
  const baseline = await save(page, info, 'baseline');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  return {
    baseline,
    errors,
    pixels: await capture(page),
    undo: await page.locator('#undo').getAttribute('title'),
    redo: await page.locator('#redo').getAttribute('title'),
  };
}
async function failed(
  page,
  info,
  state,
  action,
  stage,
  perform,
  failAt = 1,
  model = '0',
) {
  await arm(page, stage, failAt);
  await perform();
  await expect(page.locator('#toast')).toContainText(
    'The previous plants and settings were kept',
  );
  expect(await capture(page)).toBe(state.pixels);
  expect(await page.locator('#undo').getAttribute('title')).toBe(state.undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(state.redo);
  await expect(page.locator('#brush-select')).toHaveValue('0');
  await expect(page.locator('#model-entry')).toHaveValue(model);
  const fault = await page.evaluate(() => window.lastFoliageFault);
  expect(fault.stage).toBe(stage);
  await arm(page, undefined);
  expect(await save(page, info, action + '-failed')).toEqual(state.baseline);
  return { action, ...fault, exactPixelsDataHistoryAndSelection: true };
}
async function autosave(page) {
  return page.evaluate(async () => {
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
}

test('separates environment tabs and saves independent model contact settings through recovery, undo and reload', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info, true);
  await expect(page.locator('[data-tab="world"]')).toHaveCount(0);
  for (const [tab, present, absent] of [
    [
      'light',
      '#environment-preset',
      '#wind-strength, #water-sea-level, #crush-enabled',
    ],
    [
      'wind',
      '#wind-strength',
      '#environment-preset, #water-sea-level, #crush-enabled',
    ],
    [
      'water',
      '#water-sea-level',
      '#environment-preset, #wind-strength, #crush-enabled',
    ],
  ]) {
    await page.locator(`[data-tab="${tab}"]`).click();
    await expect(page.locator('.inspector h1')).toHaveText(
      tab[0].toUpperCase() + tab.slice(1),
    );
    await expect(page.locator(present)).toBeVisible();
    await expect(page.locator(absent)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(tab + '.png') });
  }
  await page.locator('[data-tab="foliage"]').click();
  await expect(page.locator('#crush-enabled')).toBeChecked();
  await (await inspectorControl(page, '#model-entry')).selectOption('1');
  await expect(page.locator('#crush-enabled')).not.toBeChecked();
  await (await inspectorControl(page, '#model-entry')).selectOption('0');
  for (const stage of ['buffers', 'history']) {
    for (const [id, value] of [
      ['crush-radius', 7],
      ['recovery', 6],
      ['brush-crush', 0.65],
    ])
      await failed(page, info, state, id + '-' + stage, stage, () =>
        range(page, id, value),
      );
    await failed(
      page,
      info,
      state,
      'contact-toggle-' + stage,
      stage,
      async () => (await inspectorControl(page, '#crush-enabled')).click(),
    );
  }
  expect(decodeDocument(Buffer.from(await autosave(page)))).toEqual(
    state.baseline,
  );
  await range(page, 'crush-radius', 7);
  await range(page, 'recovery', 6);
  await range(page, 'brush-crush', 0.65);
  await (await inspectorControl(page, '#crush-enabled')).uncheck();
  await expect(page.locator('#crush-enabled')).not.toBeChecked();
  await (await inspectorControl(page, '#crush-enabled')).check();
  const changed = await save(page, info, 'per-asset-contact');
  expect(changed.brushes[0].models[0]).toEqual({
    ...state.baseline.brushes[0].models[0],
    crush: 0.65,
    interaction: { enabled: true, radius: 7, recovery: 6 },
  });
  expect(changed.brushes[0].models[1]).toEqual(
    state.baseline.brushes[0].models[1],
  );
  expect(changed.interaction).toEqual(state.baseline.interaction);
  await (
    await inspectorControl(page, '#crush-enabled')
  ).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('foliage-contact.png') });
  for (let i = 0; i < 5; i++) {
    await page.locator('#undo').click();
    await expect(page.locator('#preparation-status')).toBeHidden();
  }
  expect(await save(page, info, 'contact-undone')).toEqual(state.baseline);
  for (let i = 0; i < 5; i++) {
    await page.locator('#redo').click();
    await expect(page.locator('#preparation-status')).toBeHidden();
  }
  expect(await save(page, info, 'contact-redone')).toEqual(changed);
  const pending = page.waitForEvent('download');
  await (await inspectorControl(page, '#save-brush')).click();
  const path = info.outputPath('contact-brush.foliage.json');
  await (await pending).saveAs(path);
  const exported = JSON.parse(await readFile(path, 'utf8'));
  expect(exported.brush.models[0].interaction).toEqual(
    changed.brushes[0].models[0].interaction,
  );
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(changed.name);
  await page.locator('[data-tab="foliage"]').click();
  await (await inspectorControl(page, '#brush-select')).selectOption('0');
  await expect(page.locator('#crush-enabled')).toBeChecked();
  await expect(page.locator('#crush-radius')).toHaveValue('7');
  await expect(page.locator('#recovery')).toHaveValue('6');
  await (await inspectorControl(page, '#model-entry')).selectOption('1');
  await expect(page.locator('#crush-enabled')).not.toBeChecked();
  expect(await save(page, info, 'contact-reloaded')).toEqual(changed);
  // Adding grass from a rigid entry starts with grass behavior, not the copied toggle.
  await range(page, 'crush-radius', 7);
  await expect(page.locator('#crush-enabled')).not.toBeChecked();
  await (await inspectorControl(page, '#add-model')).click();
  await expect(page.locator('#foliage-model')).toHaveValue('grass');
  await expect(page.locator('#crush-enabled')).toBeChecked();
  expect(state.errors).toEqual([]);
});

test('legacy brush authoring preserves data, ids and selection on failure without rebuilding future-placement settings', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info),
    evidence = [];
  expect(state.baseline.brushes[0].models).toBeUndefined();
  const metadata = [
    ['name', () => number(page, 'brush-name', 'Changed brush')],
    [
      'duplicate',
      async () => (await inspectorControl(page, '#add-brush')).click(),
    ],
    [
      'add-model',
      async () => (await inspectorControl(page, '#add-model')).click(),
    ],
    ...[
      ['density', 0.2],
      ['foliage-spacing', 3],
      ['max-foliage-slope', 40],
      ['min-weight', 0.5],
      ['model-weight', 3],
      ['min-scale', 2],
      ['max-scale', 0.2],
      ['min-rotation', 60],
      ['max-rotation', -90],
    ].map(([id, value]) => [id, () => range(page, id, value)]),
    [
      'allowed-surface',
      async () =>
        (
          await inspectorControl(page, page.locator('[data-allowed]').first())
        ).click(),
    ],
  ];
  for (const [action, perform] of metadata)
    evidence.push(await failed(page, info, state, action, 'history', perform));
  const visual = [
    ['wind', () => range(page, 'brush-wind', 1.7)],
    ['crush', () => range(page, 'brush-crush', 0.2)],
    ['align', async () => (await inspectorControl(page, '#align')).click()],
    [
      'asset',
      async () =>
        (await inspectorControl(page, '#foliage-model')).selectOption(
          'boulder',
        ),
    ],
    [
      'flexibility',
      async () =>
        (await inspectorControl(page, '#flexibility-source')).selectOption(
          'height',
        ),
    ],
    ['add-lod', async () => (await inspectorControl(page, '#add-lod')).click()],
  ];
  for (const [action, perform] of visual)
    evidence.push(await failed(page, info, state, action, 'buffers', perform));
  evidence.push(
    await failed(page, info, state, 'prepared-history', 'history', () =>
      range(page, 'brush-wind', 1.7),
    ),
  );
  expect(decodeDocument(Buffer.from(await autosave(page)))).toEqual(
    state.baseline,
  );
  // Probability changes convert legacy records but must not allocate another draw population.
  await arm(page, 'buffers');
  await range(page, 'model-weight', 3);
  expect(await page.evaluate(() => window.lastFoliageFault)).toBeUndefined();
  expect(await capture(page)).toBe(state.pixels);
  await arm(page, undefined);
  const changed = await save(page, info, 'metadata-retried');
  expect(changed.brushes[0].models[0].weight).toBe(3);
  expect(
    changed.foliage
      .filter((instance) => instance.brushId === 'pine')
      .every((instance) => instance.modelId === 'primary'),
  ).toBe(true);
  expect(
    changed.foliage.filter((instance) => instance.brushId === 'grass'),
  ).toEqual(
    state.baseline.foliage.filter((instance) => instance.brushId === 'grass'),
  );
  expect(changed.nextId).toBe(state.baseline.nextId);
  await expect(page.locator('#redo')).toBeDisabled();
  await page.locator('#undo').click();
  expect(await save(page, info, 'undone')).toEqual(state.baseline);
  await page.locator('#redo').click();
  expect(await save(page, info, 'redone')).toEqual(changed);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(changed.name);
  expect(await save(page, info, 'reopened')).toEqual(changed);
  expect(state.errors).toEqual([]);
  await writeFile(
    info.outputPath('legacy-recovery.json'),
    JSON.stringify(
      {
        evidence,
        unchangedCommittedAutosave: true,
        metadataRetryWithoutDrawAllocation: true,
        legacyConversionUndoRedoAndReload: true,
        errors: state.errors,
      },
      null,
      2,
    ),
  );
});

test('population, clearing, model removal and detailed response edits recover then commit as one undoable change', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info, true),
    evidence = [];
  for (const [stage, failAt] of [
    ['population', 4],
    ['buffers', 2],
    ['history', 1],
  ])
    evidence.push(
      await failed(
        page,
        info,
        state,
        'populate-' + stage,
        stage,
        async () => (await inspectorControl(page, '#populate')).click(),
        failAt,
      ),
    );
  for (const stage of ['buffers', 'history'])
    evidence.push(
      await failed(page, info, state, 'clear-' + stage, stage, async () =>
        (await inspectorControl(page, '#clear-brush')).click(),
      ),
    );
  await (await inspectorControl(page, '#model-entry')).selectOption('1');
  for (const stage of ['buffers', 'history'])
    evidence.push(
      await failed(
        page,
        info,
        state,
        'remove-model-' + stage,
        stage,
        async () => (await inspectorControl(page, '#remove-model')).click(),
        1,
        '1',
      ),
    );
  await (await inspectorControl(page, '#model-entry')).selectOption('0');
  for (const [id, value] of [
    ['flexibility-start', 0.3],
    ['flexibility-end', 0.8],
    ['flexibility-exponent', 3],
    ['lod-distance-0', 120],
    ['lod-density-0', 50],
    ['foliage-cull-distance', 300],
    ['foliage-lod-hysteresis', 25],
    ['foliage-lod-fade', 0.25],
  ])
    evidence.push(
      await failed(page, info, state, id, 'history', () =>
        number(page, id, value),
      ),
    );
  evidence.push(
    await failed(page, info, state, 'lod-asset', 'buffers', async () =>
      (await inspectorControl(page, '#lod-model-0')).selectOption('grass'),
    ),
  );
  evidence.push(
    await failed(page, info, state, 'remove-lod', 'history', async () =>
      (await inspectorControl(page, '[data-remove-lod="0"]')).click(),
    ),
  );
  expect(decodeDocument(Buffer.from(await autosave(page)))).toEqual(
    state.baseline,
  );
  await (await inspectorControl(page, '#clear-brush')).click();
  await expect(page.locator('#toast')).toContainText('plants were cleared');
  await expect(page.locator('#clear-brush')).toBeDisabled();
  const cleared = await save(page, info, 'cleared');
  expect(cleared.foliage).toEqual(
    state.baseline.foliage.filter((instance) => instance.brushId !== 'pine'),
  );
  expect(cleared.brushes).toEqual(state.baseline.brushes);
  expect(cleared.nextId).toBe(state.baseline.nextId);
  await page.locator('#undo').click();
  expect(await save(page, info, 'clear-undone')).toEqual(state.baseline);
  await page.locator('#redo').click();
  expect(await save(page, info, 'clear-redone')).toEqual(cleared);
  await page.locator('#undo').click();
  await (await inspectorControl(page, '#populate')).click();
  await expect(page.locator('#toast')).toContainText('instances placed');
  const populated = await save(page, info, 'populated');
  const plants = populated.foliage.filter(
    (instance) => instance.brushId === 'pine',
  );
  expect(plants.length).toBeGreaterThan(10);
  expect(plants.length).toBeLessThanOrEqual(49998);
  expect(new Set(plants.map((instance) => instance.modelId)).size).toBe(2);
  expect(Math.min(...plants.map((instance) => instance.id))).toBe(5);
  expect(populated.nextId).toBe(5 + plants.length);
  expect(
    populated.foliage.filter((instance) => instance.brushId !== 'pine'),
  ).toEqual(cleared.foliage);
  await page.screenshot({
    path: info.outputPath('population-retried.png'),
    fullPage: true,
  });
  await page.locator('#undo').click();
  expect(await save(page, info, 'population-undone')).toEqual(state.baseline);
  await page.locator('#redo').click();
  expect(await save(page, info, 'population-redone')).toEqual(populated);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(populated.name);
  expect(await save(page, info, 'reopened')).toEqual(populated);
  // Painting into an empty brush must enable Clear without rebuilding the inspector.
  await page.locator('[data-tab="foliage"]').click();
  await (await inspectorControl(page, '#brush-select')).selectOption('0');
  await (await inspectorControl(page, '#clear-brush')).click();
  await expect(page.locator('#clear-brush')).toBeDisabled();
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.mouse.down();
  await expect
    .poll(async () =>
      parseInt(await page.locator('#foliage-detail-stats').textContent(), 10),
    )
    .toBeGreaterThan(2);
  await page.mouse.up();
  await expect(page.locator('#clear-brush')).toBeEnabled();
  const painted = await save(page, info, 'painted-after-clear');
  expect(
    painted.foliage.filter((instance) => instance.brushId === 'pine').length,
  ).toBeGreaterThan(0);
  await (await inspectorControl(page, '#clear-brush')).click();
  await expect(page.locator('#clear-brush')).toBeDisabled();
  await page.locator('#undo').click();
  await expect(page.locator('#clear-brush')).toBeEnabled();
  expect(await save(page, info, 'paint-clear-undone')).toEqual(painted);
  expect(state.errors).toEqual([]);
  await writeFile(
    info.outputPath('population-recovery.json'),
    JSON.stringify(
      {
        evidence,
        unchangedCommittedAutosave: true,
        clearPreservesOtherBrushesAndDefinitions: true,
        clearButtonTracksPaintingAndUndo: true,
        populationCount: plants.length,
        reusedUnconsumedFirstId: plants[0].id,
        retryUndoRedoAndReload: true,
        errors: state.errors,
      },
      null,
      2,
    ),
  );
});
