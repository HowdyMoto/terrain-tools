import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
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
async function capture(page) {
  await page.mouse.move(50, 30);
  return page.locator('#viewport canvas').evaluate(async (canvas) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return canvas.toDataURL();
  });
}
async function set(page, id, value) {
  const tab = id.startsWith('wind-')
    ? 'wind'
    : id === 'water' || id === 'water-sea-level'
      ? 'water'
      : id === 'low-poly' || id === 'wireframe'
        ? 'light'
        : undefined;
  if (tab) await page.locator(`[data-tab="${tab}"]`).click();
  await page.locator('#' + id).evaluate((input, value) => {
    if (typeof value === 'boolean') input.checked = value;
    else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
}
async function arm(page, stage) {
  await page.evaluate((stage) => {
    window.settingsFault = stage;
    window.settingsFaults = [];
    window.settingsAllocations = {};
  }, stage);
}
async function autosave(page) {
  const bytes = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('terrain-studio', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const blob = await new Promise((resolve, reject) => {
        const request = db
          .transaction('projects')
          .objectStore('projects')
          .get('autosave');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return [...new Uint8Array(await blob.arrayBuffer())];
    } finally {
      db.close();
    }
  });
  return decodeDocument(Buffer.from(bytes));
}
async function setup(page, info, tab = 'light') {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /THREE|Shader|WebGL/i.test(m.text()))
      errors.push(m.text());
  });
  await page.addInitScript(() => {
    const probe = (stage) => {
      if (!window.settingsAllocations) return;
      window.settingsAllocations[stage] =
        (window.settingsAllocations[stage] ?? 0) + 1;
      if (
        window.settingsFault === stage ||
        (window.settingsFault === 'spatial' &&
          ['terrain', 'foliage', 'picking', 'colliders'].includes(stage))
      ) {
        window.settingsFaults.push(stage);
        throw new RangeError('Injected settings ' + stage + ' failure');
      }
    };
    for (const name of [
      'Float32Array',
      'Uint32Array',
      'Uint8Array',
      'Uint16Array',
    ]) {
      const Original = window[name];
      window[name] = new Proxy(Original, {
        construct(target, args, constructor) {
          const n = args[0];
          if (name === 'Uint8Array' && args.length === 3 && args[2] === 16900)
            probe('history');
          if (name === 'Uint16Array' && n === 512 * 256 * 4) probe('sky');
          if (name === 'Uint16Array' && n === 24 * 8 * 24 * 4) probe('canopy');
          if (name === 'Float32Array' && n === 3267)
            probe(
              new Error().stack.includes('/assets/rapier-')
                ? 'colliders'
                : 'terrain',
            );
          if (name === 'Uint32Array' && n === 6144) probe('picking');
          if (
            name === 'Float32Array' &&
            // The fixture has one pine instance (one 4×4 matrix). Water
            // prepares its own larger vertex/weight arrays in this chunk.
            n === 16 &&
            new Error().stack.includes('/assets/terrain-scene-')
          )
            probe('foliage');
          return Reflect.construct(target, args, constructor);
        },
      });
      // Native vertex-format lookup keys by constructor identity. Keep our
      // allocation fault proxy transparent to that lookup.
      Original.prototype.constructor = window[name];
    }
    const postWorker = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...transfer) {
      if (window.pauseCanopy && message?.kind === 'canopy') {
        window.pausedCanopy = true;
        return;
      }
      return postWorker.call(this, message, ...transfer);
    };
    const createTexture = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (descriptor) {
      if (
        window.settingsFault === 'canopy-gpu' &&
        descriptor.label === 'Terrain canopy light field'
      ) {
        window.settingsFaults.push('canopy-gpu');
        createTexture
          .call(this, { size: [1, 1], format: 'rgba8unorm', usage: 0 })
          .destroy();
      }
      return createTexture.call(this, descriptor);
    };
    const push = Array.prototype.push;
    Array.prototype.push = function (...items) {
      for (const item of items) {
        if (item?.mesh?.isMesh && typeof item.body?.translation === 'function')
          window.settingsBody = item;
      }
      return Reflect.apply(push, this, items);
    };
  });
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  const project = createProject(64, 64);
  generateTerrain(project, 'flat');
  project.name = 'Settings recovery';
  project.view.water = false;
  project.view.textureResolution = 256;
  project.wind.enabled = false;
  project.foliage = [
    { id: 1, brushId: 'pine', x: -8, z: -8, scale: 1, rotation: 0 },
  ];
  project.nextId = 2;
  await page.locator('#file-open').setInputFiles({
    name: 'settings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 60000,
  });
  await expect(page.locator('#project-name')).toHaveValue(project.name, {
    timeout: 60000,
  });
  await page.locator(`[data-tab="${tab}"]`).click();
  if (tab === 'sculpt')
    await (await inspectorControl(page, '[data-tool="stamp"]')).click();
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(project.name, {
    timeout: 60000,
  });
  await expect(page.locator('#redo')).toBeEnabled();
  await page.locator('#frame').click();
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
async function fails(page, info, state, stage, id, value, message) {
  await arm(page, stage);
  if (id.startsWith('click:'))
    await (await inspectorControl(page, '#' + id.slice(6))).click();
  else await set(page, id, value);
  await expect(page.locator('#toast')).toContainText(message);
  expect(await page.evaluate(() => window.settingsFaults)).toEqual([stage]);
  expect(await capture(page)).toBe(state.pixels);
  expect(await page.locator('#undo').getAttribute('title')).toBe(state.undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(state.redo);
  // Read the existing autosave before Save project can write again.
  expect(await autosave(page)).toEqual(state.baseline);
  await arm(page);
  expect(await save(page, info, id.replace(':', '-') + '-failed')).toEqual(
    state.baseline,
  );
}
async function restore(page, direction) {
  await (await inspectorControl(page, '#' + direction)).click();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
}
const worldEdits = [
  ['wind-strength', 2.4],
  ['wind-direction', 240],
  ['wind-speed', 2.5],
  ['wind-gust', 0.8],
  ['water-sea-level', 2],
  ['wind-enabled', true],
  ['low-poly', true],
  ['wireframe', true],
  ['water', true],
];

test('light, wind and water controls preserve pixels, saved data and redo after history failure, including toolbar toggles', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info);
  for (const [id, value] of [
    ...worldEdits,
    ['click:wire'],
    ['click:water-toggle'],
  ]) {
    await fails(
      page,
      info,
      state,
      'history',
      id,
      value,
      id.includes('water')
        ? 'The previous water was kept'
        : 'The previous settings were kept',
    );
  }
  await fails(
    page,
    info,
    state,
    'history',
    'project-name',
    'Lost rename',
    'Could not rename',
  );
  await expect(page.locator('#project-name')).toHaveValue(state.baseline.name);
  expect(state.errors).toEqual([]);
});

test('light, wind and water edits retain live physics and avoid spatial rebuilds, then undo, redo and reload exactly', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info);
  await page.locator('#physics').click();
  await expect(page.locator('#physics-state')).toHaveText(
    'Terrain collision active',
    { timeout: 30000 },
  );
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.65);
  await page.waitForFunction(() => !!window.settingsBody, undefined, {
    timeout: 10000,
  });
  await expect
    .poll(() => page.evaluate(() => window.settingsBody.body.isSleeping()), {
      timeout: 20000,
    })
    .toBe(true);
  const position = await page.evaluate(() =>
    window.settingsBody.body.translation(),
  );
  await arm(page, 'spatial');
  for (const [id, value] of worldEdits) await set(page, id, value);
  await expect(page.locator('#shading-label')).toHaveText('Flat');
  await expect(page.locator('#water-toggle')).toHaveText('On');
  expect(await page.evaluate(() => window.settingsFaults)).toEqual([]);
  const allocations = await page.evaluate(() => window.settingsAllocations);
  for (const stage of ['terrain', 'foliage', 'picking', 'colliders'])
    expect(allocations[stage] ?? 0).toBe(0);
  expect(
    await page.evaluate(() => ({
      valid: window.settingsBody.body.isValid(),
      parent: !!window.settingsBody.mesh.parent,
      position: window.settingsBody.body.translation(),
    })),
  ).toEqual({ valid: true, parent: true, position });
  await arm(page);
  const changed = await save(page, info, 'changed');
  const water = defaultWaterSettings(state.baseline);
  water.seaLevel = 2;
  water.ocean.enabled = true;
  expect(changed).toEqual({
    ...state.baseline,
    water,
    wind: {
      enabled: true,
      strength: 2.4,
      direction: 240,
      speed: 2.5,
      gust: 0.8,
    },
    view: {
      ...state.baseline.view,
      lowPoly: true,
      wireframe: true,
      water: true,
      waterLevel: 2,
    },
  });
  for (const _ of worldEdits) await restore(page, 'undo');
  expect(await save(page, info, 'undone')).toEqual(state.baseline);
  for (const _ of worldEdits) await restore(page, 'redo');
  expect(await save(page, info, 'redone')).toEqual(changed);
  await expect.poll(() => autosave(page)).toEqual(changed);
  await page.reload();
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 90000,
  });
  await expect(page.locator('#project-name')).toHaveValue(changed.name);
  expect(await save(page, info, 'reloaded')).toEqual(changed);
  expect(state.errors).toEqual([]);
});

test('sculpt settings and names recover failed history capture and retry as one undo step', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info, 'sculpt');
  for (const [id, value] of [
    ['sculpt-preset-name', 'New stamp'],
    ['erode-talus', 45],
    ['alpha-kind', 'ridge'],
    ['alpha-rotation', 70],
    ['stamp-height', 15],
    ['stamp-base', 2],
    ['stamp-mode', 'subtract'],
    ['pen-pressure', false],
  ]) {
    await fails(
      page,
      info,
      state,
      'history',
      id,
      value,
      'The previous settings were kept',
    );
  }
  await set(page, 'alpha-rotation', 70);
  const changed = await save(page, info, 'rotated');
  expect(changed.sculpt.rotation).toBe(70);
  await restore(page, 'undo');
  expect(await save(page, info, 'undone')).toEqual(state.baseline);
  await restore(page, 'redo');
  expect(await save(page, info, 'redone')).toEqual(changed);
  await expect.poll(() => autosave(page)).toEqual(changed);
  expect(state.errors).toEqual([]);
});

test('lighting controls restore their displayed values after sky or history failures and retry cleanly', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info);
  for (const stage of ['sky', 'history']) {
    await fails(
      page,
      info,
      state,
      stage,
      'environment-preset',
      'golden',
      'Could not update lighting',
    );
    await expect(page.locator('#environment-preset')).toHaveValue('custom');
    await expect(page.locator('#env-exposure')).toHaveValue(
      String(state.baseline.environment.exposure),
    );
  }
  for (const [id, value] of [
    ['env-exposure', 2],
    ['env-fogEnabled', false],
    ['env-shadowResolution', 1024],
  ]) {
    await fails(
      page,
      info,
      state,
      'history',
      id,
      value,
      'Could not update lighting',
    );
  }
  await set(page, 'environment-preset', 'golden');
  await expect(page.locator('#env-sunElevation')).toHaveValue('16');
  const changed = await save(page, info, 'golden');
  await restore(page, 'undo');
  expect(await save(page, info, 'undone')).toEqual(state.baseline);
  await restore(page, 'redo');
  expect(await save(page, info, 'redone')).toEqual(changed);
  await expect.poll(() => autosave(page)).toEqual(changed);
  expect(state.errors).toEqual([]);
});

test('canopy lighting failure and cancellation preserve the document, controls, pixels, autosave and redo before retry and reload', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info);
  await fails(
    page,
    info,
    state,
    'canopy',
    'click:env-canopy-enabled',
    true,
    'Could not update lighting',
  );
  await expect(page.locator('#env-canopy-enabled')).not.toBeChecked();
  await fails(
    page,
    info,
    state,
    'canopy-gpu',
    'click:env-canopy-enabled',
    true,
    'Could not update lighting',
  );
  await expect(page.locator('#env-canopy-enabled')).not.toBeChecked();
  await page.evaluate(() => {
    window.pauseCanopy = true;
    window.pausedCanopy = false;
  });
  await (await inspectorControl(page, '#env-canopy-enabled')).check();
  await page.waitForFunction(() => window.pausedCanopy);
  await page.locator('#cancel-preparation').click();
  await expect(page.locator('#env-canopy-enabled')).not.toBeChecked();
  expect(await capture(page)).toBe(state.pixels);
  expect(await autosave(page)).toEqual(state.baseline);
  expect(await page.locator('#redo').getAttribute('title')).toBe(state.redo);
  expect(await save(page, info, 'canopy-cancel')).toEqual(state.baseline);
  await page.evaluate(() => {
    window.pauseCanopy = false;
  });
  await (await inspectorControl(page, '#env-canopy-enabled')).check();
  await expect(page.locator('#preparation-status')).toBeHidden({
    timeout: 60000,
  });
  const changed = await save(page, info, 'canopy-retry');
  expect(changed.environment.canopyLighting.enabled).toBe(true);
  await restore(page, 'undo');
  expect(await save(page, info, 'canopy-undo')).toEqual(state.baseline);
  await restore(page, 'redo');
  expect(await save(page, info, 'canopy-redo')).toEqual(changed);
  await expect.poll(() => autosave(page)).toEqual(changed);
  await page.reload();
  await expect(page.locator('#app')).not.toHaveAttribute('inert', {
    timeout: 60000,
  });
  expect(await save(page, info, 'canopy-reload')).toEqual(changed);
  expect(state.errors).toEqual([]);
});
