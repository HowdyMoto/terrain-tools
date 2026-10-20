import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  createProject,
  generateTerrain,
  serializeProject,
  serializeMaterialPreset,
  parseMaterialPreset,
  applyMaterialPreset,
} from 'terrain-tools';
import { decodeDocument, solidPng } from './fixtures.mjs';

async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name + '.terrain');
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function capture(page) {
  await page.mouse.move(50, 30);
  const pixels = await page
    .locator('#viewport canvas')
    .evaluate(async (canvas) => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return canvas.toDataURL();
    });
  return createHash('sha256').update(pixels).digest('hex');
}
async function range(page, id, value) {
  await page.locator('#' + id).evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function arm(page, stage, failAt = 1) {
  await page.evaluate(
    ({ stage, failAt }) => {
      window.surfaceFault = stage ? { stage, failAt, calls: 0 } : undefined;
      window.lastSurfaceFault = undefined;
      window.surfaceAllocations = {};
    },
    { stage, failAt },
  );
}
async function setup(page, info) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /THREE|Shader|WebGL/i.test(m.text()))
      errors.push(m.text());
  });
  await page.addInitScript(() => {
    const fail = (stage) => {
      if (window.surfaceAllocations)
        window.surfaceAllocations[stage] =
          (window.surfaceAllocations[stage] ?? 0) + 1;
      const fault = window.surfaceFault;
      if (fault && fault.stage === stage && ++fault.calls >= fault.failAt) {
        window.lastSurfaceFault = { ...fault };
        throw new RangeError('Injected surface ' + stage + ' failure');
      }
    };
    for (const name of ['Float32Array', 'Uint32Array', 'Uint8Array']) {
      const Original = window[name];
      window[name] = new Proxy(Original, {
        construct(target, args, constructor) {
          const n = args[0];
          if (name === 'Float32Array' && n === 3267) {
            if (new Error().stack.includes('/assets/rapier-'))
              fail('colliders');
            else fail('terrain');
          }
          if (
            name === 'Float32Array' &&
            typeof n === 'number' &&
            n >= 16 &&
            n % 16 === 0 &&
            n !== 288 &&
            new Error().stack.includes('/assets/terrain-scene-')
          )
            fail('foliage');
          if (name === 'Uint32Array' && n === 6144) fail('picking');
          if (name === 'Uint8Array' && args.length === 3 && args[2] === 16900)
            fail('history');
          if (name === 'Uint8Array' && (n === 1048576 || n === 4194304))
            fail('maps');
          return Reflect.construct(target, args, constructor);
        },
      });
      // WebGPU indexes vertex formats by constructor identity. Keep arrays
      // created by the allocation probe consistent with the installed global.
      Object.defineProperty(Original.prototype, 'constructor', {
        value: window[name],
        configurable: true,
        writable: true,
      });
    }
    const entries = Object.entries;
    Object.entries = function (value) {
      if (value?.terrainAlbedo?.isDataArrayTexture && value.layerColors)
        fail('uniforms');
      return entries(value);
    };
    const clone = window.structuredClone;
    window.structuredClone = function (value, options) {
      if (
        Array.isArray(value) &&
        value.length === 4 &&
        value.every((layer) => layer.id && layer.textures)
      )
        fail('draft');
      return clone(value, options);
    };
    const src = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'src',
    );
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(value) {
        if (window.holdSurfaceImage && value.startsWith('data:image/')) {
          window.releaseSurfaceImage = () => src.set.call(this, value);
          return;
        }
        src.set.call(this, value);
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const project = createProject(64, 64);
  generateTerrain(project, 'flat');
  project.name = 'Recoverable surface';
  project.view.water = false;
  project.view.textureResolution = 256;
  project.wind.enabled = false;
  project.materials[0].textures.albedo =
    'data:image/png;base64,' + solidPng(100, 160, 80).toString('base64');
  project.materials[1].color = '#8a4c26';
  for (let z = 20; z < 40; z++)
    for (let x = 20; x < 40; x++) project.paint[(z * 65 + x) * 4 + 1] = 1;
  project.holes[9] = 1;
  project.foliage = [
    { id: 1, brushId: 'pine', x: -7, z: 2, scale: 1, rotation: 0 },
  ];
  project.props = [
    {
      id: 2,
      model: 'platform',
      x: 8,
      z: 0,
      yOffset: 1,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 2,
    },
  ];
  project.nextId = 3;
  await page.locator('#file-open').setInputFiles({
    name: 'surface.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('#physics').click();
  await expect(page.locator('#physics-state')).toHaveText(
    'Terrain collision active',
    { timeout: 30000 },
  );
  await page.locator('[data-tab="materials"]').click();
  await page.locator('#frame').click();
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
  message = 'The previous surface and paint were kept',
) {
  await arm(page, stage, failAt);
  await perform();
  await expect(page.locator('#preparation-status')).toBeHidden();
  await expect(page.locator('#toast')).toContainText(message);
  await expect
    .poll(() => capture(page), { message: `${action}: ${stage}` })
    .toBe(state.pixels);
  expect(await page.locator('#undo').getAttribute('title')).toBe(state.undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(state.redo);
  await expect(page.locator('#mat-name')).toHaveValue(
    state.baseline.materials[0].name,
  );
  const fault = await page.evaluate(() => window.lastSurfaceFault);
  expect(fault.stage).toBe(stage);
  await arm(page);
  expect(await save(page, info, action + '-failed')).toEqual(state.baseline);
  return { action, ...fault, exactPixelsDataHistoryAndSelection: true };
}
async function autosave(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('terrain-studio', 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const blob = await new Promise((resolve, reject) => {
      const r = db
        .transaction('projects', 'readonly')
        .objectStore('projects')
        .get('autosave');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
}
async function undoRedo(page, info, baseline, changed) {
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, info, 'undone')).toEqual(baseline);
  await page.locator('#redo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, info, 'redone')).toEqual(changed);
}

test('surface controls preserve rendering, paint and redo through preparation failures and retry without spatial rebuilds', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info),
    evidence = [];
  const controls = [
    ...[
      ['roughness', 0.3],
      ['metalness', 0.6],
      ['normal-strength', 1.8],
      ['tile', 7],
      ['blend', 0.7],
      ['min-height', 20],
      ['max-height', -20],
      ['min-slope', 50],
      ['max-slope', 10],
      ['feather', 12],
    ].map(([id, value]) => [id, () => range(page, id, value)]),
    [
      'normal-convention',
      async () =>
        (await inspectorControl(page, '#normal-convention')).selectOption(
          'directx',
        ),
    ],
    [
      'reduce-tiling',
      async () => (await inspectorControl(page, '#reduce-tiling')).click(),
    ],
    [
      'name',
      async () => {
        await (await inspectorControl(page, '#mat-name')).fill('New surface');
        await (await inspectorControl(page, '#mat-name')).press('Tab');
      },
    ],
    [
      'tint',
      () =>
        page.locator('#mat-color').evaluate((input) => {
          input.value = '#ba4242';
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }),
    ],
  ];
  for (const [action, perform] of controls)
    evidence.push(await failed(page, info, state, action, 'history', perform));
  for (const stage of ['draft', 'uniforms'])
    evidence.push(
      await failed(page, info, state, stage, stage, () =>
        range(page, 'roughness', 0.3),
      ),
    );
  for (const stage of ['maps', 'history']) {
    evidence.push(
      await failed(
        page,
        info,
        state,
        'reset-' + stage,
        stage,
        async () => (await inspectorControl(page, '#reset-maps')).click(),
        stage === 'maps' ? 3 : 1,
      ),
    );
    evidence.push(
      await failed(
        page,
        info,
        state,
        'resolution-' + stage,
        stage,
        async () =>
          (await inspectorControl(page, '#texture-resolution')).selectOption(
            '512',
          ),
        stage === 'maps' ? 2 : 1,
      ),
    );
  }
  expect(decodeDocument(Buffer.from(await autosave(page)))).toEqual(
    state.baseline,
  );
  // Cancellation restores the edited select, and a newer scalar edit supersedes a held decode.
  for (const supersede of [false, true]) {
    await page.evaluate(() => {
      window.holdSurfaceImage = true;
      window.releaseSurfaceImage = undefined;
    });
    await (
      await inspectorControl(page, '#texture-resolution')
    ).selectOption('512');
    await page.waitForFunction(() => !!window.releaseSurfaceImage);
    if (supersede) await range(page, 'roughness', 0.3);
    else await page.locator('#cancel-preparation').click();
    await page.evaluate(() => {
      window.holdSurfaceImage = false;
      window.releaseSurfaceImage();
    });
    await expect(page.locator('#preparation-status')).toBeHidden();
    await expect(page.locator('#texture-resolution')).toHaveValue('256');
    if (!supersede) {
      expect(await capture(page)).toBe(state.pixels);
      expect(await save(page, info, 'cancelled-resolution')).toEqual(
        state.baseline,
      );
    }
  }
  const changed = structuredClone(state.baseline);
  changed.materials[0].roughness = 0.3;
  expect(await save(page, info, 'superseding-scalar')).toEqual(changed);
  await undoRedo(page, info, state.baseline, changed);
  await arm(page, 'terrain');
  await range(page, 'normal-strength', 1.8);
  await expect(page.locator('#preparation-status')).toBeHidden();
  const allocations = await page.evaluate(() => ({
    ...window.surfaceAllocations,
  }));
  expect(allocations.uniforms).toBe(1);
  for (const key of ['terrain', 'picking', 'foliage', 'colliders', 'maps'])
    expect(allocations[key] ?? 0).toBe(0);
  expect(await page.evaluate(() => window.lastSurfaceFault)).toBeUndefined();
  await arm(page);
  changed.materials[0].normalStrength = 1.8;
  expect(await save(page, info, 'scalar-retried')).toEqual(changed);
  await (await inspectorControl(page, '#reset-maps')).click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  const reset = structuredClone(changed);
  reset.materials[0].textures = {};
  expect(await save(page, info, 'reset-retried')).toEqual(reset);
  await undoRedo(page, info, changed, reset);
  changed.materials[0].textures = {};
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(changed.name);
  expect(await save(page, info, 'reopened')).toEqual(changed);
  expect(state.errors).toEqual([]);
  await writeFile(
    info.outputPath('surface-controls-recovery.json'),
    JSON.stringify(
      {
        evidence,
        allocations,
        unchangedCommittedAutosave: true,
        cancellationAndSupersession: true,
        retryUndoRedoAndReload: true,
        errors: state.errors,
      },
      null,
      2,
    ),
  );
});

test('placement rules, painted coverage and presets prepare terrain and picking before committing history', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info),
    evidence = [];
  const presetProject = createProject(32, 64);
  Object.assign(presetProject.materials[0], {
    name: 'High dry ground',
    color: '#bd8666',
    minHeight: 20,
    maxHeight: 45,
    minSlope: 10,
    maxSlope: 65,
    feather: 3,
  });
  const presetText = serializeMaterialPreset(
    presetProject,
    presetProject.materials[0].id,
  );
  const load = () =>
    page.locator('#surface-preset-open').setInputFiles({
      name: 'dry.surface.json',
      mimeType: 'application/json',
      buffer: Buffer.from(presetText),
    });
  await (await inspectorControl(page, '#surface-preset-rules')).check();
  for (const [stage, failAt] of [
    ['terrain', 3],
    ['picking', 2],
    ['history', 1],
  ]) {
    evidence.push(
      await failed(
        page,
        info,
        state,
        'rule-' + stage,
        stage,
        () => range(page, 'min-height', 20),
        failAt,
      ),
    );
    evidence.push(
      await failed(
        page,
        info,
        state,
        'clear-' + stage,
        stage,
        async () => (await inspectorControl(page, '#clear-paint')).click(),
        failAt,
      ),
    );
    evidence.push(
      await failed(
        page,
        info,
        state,
        'preset-' + stage,
        stage,
        load,
        failAt,
        'Could not load surface preset',
      ),
    );
  }
  evidence.push(
    await failed(
      page,
      info,
      state,
      'texture-history',
      'history',
      () =>
        page.locator('#texture-open').setInputFiles({
          name: 'new.png',
          mimeType: 'image/png',
          buffer: solidPng(130, 60, 80),
        }),
      1,
      'Injected surface history failure',
    ),
  );
  expect(decodeDocument(Buffer.from(await autosave(page)))).toEqual(
    state.baseline,
  );
  await arm(page, 'foliage');
  await range(page, 'min-height', 20);
  await expect(page.locator('#preparation-status')).toBeHidden();
  const allocations = await page.evaluate(() => ({
    ...window.surfaceAllocations,
  }));
  expect(allocations.terrain).toBe(8);
  expect(allocations.picking).toBe(4);
  for (const key of ['foliage', 'colliders', 'maps'])
    expect(allocations[key] ?? 0).toBe(0);
  await arm(page);
  const rules = structuredClone(state.baseline);
  rules.materials[0].minHeight = 20;
  rules.materials[0].maxHeight = Math.max(20, rules.materials[0].maxHeight);
  expect(await save(page, info, 'rule-retried')).toEqual(rules);
  await undoRedo(page, info, state.baseline, rules);
  await (await inspectorControl(page, '#clear-paint')).click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  const clear = structuredClone(rules);
  clear.paint.fill(0);
  expect(await save(page, info, 'paint-cleared')).toEqual(clear);
  expect(await capture(page)).not.toBe(state.pixels);
  await undoRedo(page, info, rules, clear);
  await load();
  await expect(page.locator('#toast')).toContainText('Surface preset loaded');
  const final = structuredClone(clear);
  final.materials[0] = applyMaterialPreset(
    final.materials[0],
    parseMaterialPreset(presetText),
    { applyPlacementRules: true },
  );
  expect(await save(page, info, 'preset-retried')).toEqual(final);
  await undoRedo(page, info, clear, final);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await (
    await inspectorControl(page, '#save-surface-preset')
  ).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('surface-retried.png') });
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(final.name);
  expect(await save(page, info, 'reopened')).toEqual(final);
  expect(state.errors).toEqual([]);
  await writeFile(
    info.outputPath('surface-rules-recovery.json'),
    JSON.stringify(
      {
        evidence,
        allocations,
        unchangedCommittedAutosave: true,
        retryUndoRedoAndReload: true,
        errors: state.errors,
      },
      null,
      2,
    ),
  );
});
