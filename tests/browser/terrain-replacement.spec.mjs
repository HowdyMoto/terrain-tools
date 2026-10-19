import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createProject,
  generateTerrain,
  serializeProject,
  defaultSculptSettings,
  defaultErosionSettings,
  applyHeightmap,
  decodeRaw16,
} from 'terrain-tools';
import { decodeDocument, solidPng, triangleGlb } from './fixtures.mjs';

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
async function number(page, id, value) {
  await (await inspectorControl(page, '#' + id)).fill(String(value));
  await (await inspectorControl(page, '#' + id)).press('Tab');
}
async function arm(page, stage, failAt = 1, candidateLength = 4225) {
  await page.evaluate(
    ({ stage, failAt, candidateLength }) => {
      window.replacementFault = stage
        ? { stage, failAt, calls: 0, candidateLength }
        : undefined;
      window.lastReplacementFault = undefined;
      window.replacementAllocations = {};
    },
    { stage, failAt, candidateLength },
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
      if (window.replacementAllocations)
        window.replacementAllocations[stage] =
          (window.replacementAllocations[stage] ?? 0) + 1;
      const fault = window.replacementFault;
      if (fault && fault.stage === stage && ++fault.calls >= fault.failAt) {
        window.lastReplacementFault = { ...fault };
        throw new RangeError('Injected replacement ' + stage + ' failure');
      }
    };
    for (const name of ['Float32Array', 'Uint32Array', 'Uint8Array']) {
      const Original = window[name];
      window[name] = new Proxy(Original, {
        construct(target, args, constructor) {
          const n = args[0];
          if (
            name === 'Float32Array' &&
            n === window.replacementFault?.candidateLength
          )
            fail('candidate');
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
    }
    const push = Array.prototype.push;
    Array.prototype.push = function (...items) {
      for (const item of items) {
        if (
          item?.mesh?.isMesh &&
          typeof item?.body?.translation === 'function'
        ) {
          window.replacementBody = item;
          window.replacementBodyInitial = item.mesh.position.toArray();
        }
      }
      return Reflect.apply(push, this, items);
    };
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const result = read.call(this);
      if (this.name !== 'held.r16') return result;
      return new Promise((resolve, reject) => {
        window.releaseHeightmapRead = () => result.then(resolve, reject);
      });
    };
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const project = createProject(64, 64, 23);
  generateTerrain(project, 'flat');
  project.name = 'Recoverable landscape';
  Object.assign(project.view, {
    water: false,
    textureResolution: 256,
    lowPoly: true,
  });
  Object.assign(project.wind, { enabled: false, strength: 1.3, speed: 2.2 });
  Object.assign(project.interaction, {
    enabled: false,
    radius: 7,
    recovery: 4.2,
  });
  project.sculpt = defaultSculptSettings();
  project.sculpt.rotation = 40;
  project.erosion = defaultErosionSettings();
  project.erosion.talus = 41;
  project.environment.exposure = 1.3;
  project.materials[0].textures.albedo =
    'data:image/png;base64,' + solidPng(100, 160, 80).toString('base64');
  project.assets['asset-custom'] = {
    name: 'Reusable plant.glb',
    data: 'data:model/gltf-binary;base64,' + triangleGlb().toString('base64'),
  };
  Object.assign(project.brushes[0], {
    name: 'Imported planting mix',
    model: 'asset-custom',
    density: 0.02,
    spacing: 2,
    minWeight: 0.01,
    maxSlope: 90,
    materials: project.materials.map((m) => m.id),
  });
  for (let z = 20; z < 40; z++)
    for (let x = 20; x < 40; x++) project.paint[(z * 65 + x) * 4 + 1] = 1;
  project.holes[9] = 1;
  project.foliage = [
    { id: 1, brushId: 'pine', x: -7, z: 2, scale: 1, rotation: 0 },
    { id: 3, brushId: 'grass', x: -12, z: 0, scale: 1, rotation: 0 },
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
  project.nextId = 91;
  await page.locator('#file-open').setInputFiles({
    name: 'landscape.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await expect(page.locator('#redo')).toBeEnabled();
  await page.locator('[data-prop="2"]').click();
  await page.locator('[data-tab="light"]').click();
  await page.locator('#frame').click();
  await page.locator('#physics').click();
  await expect(page.locator('#physics-state')).toHaveText(
    'Terrain collision active',
    { timeout: 30000 },
  );
  await expect(page.locator('#physics')).toContainText(
    'Click terrain to drop a body',
  );
  const empty = await capture(page);
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.65);
  await page.waitForFunction(() => !!window.replacementBody);
  await page.locator('[data-tab="sculpt"]').click();
  let previous = '',
    stable = 0;
  await expect
    .poll(
      async () => {
        const pixels = await capture(page);
        stable = pixels === previous ? stable + 1 : 0;
        previous = pixels;
        return stable;
      },
      { timeout: 15000, intervals: [150] },
    )
    .toBeGreaterThanOrEqual(6);
  const body = await page.evaluate(() => ({
    initial: window.replacementBodyInitial,
    velocity: window.replacementBody?.body.linvel(),
    position: window.replacementBody?.mesh.position.toArray(),
    visible: !!window.replacementBody?.mesh.parent,
  }));
  await writeFile(
    info.outputPath('body-state.json'),
    JSON.stringify(body, null, 2),
  );
  expect(body.visible).toBe(true);
  expect(body.position[1]).toBeGreaterThan(1.3);
  expect(body.position[1]).toBeLessThan(1.5);
  expect(previous === empty).toBe(false);
  await page.screenshot({ path: info.outputPath('before-replacement.png') });
  const baseline = await save(page, info, 'baseline');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  return {
    baseline,
    errors,
    pixels: previous,
    undo: await page.locator('#undo').getAttribute('title'),
    redo: await page.locator('#redo').getAttribute('title'),
  };
}
async function assertKept(page, info, state, name) {
  expect(await capture(page)).toBe(state.pixels);
  expect(
    await page.evaluate(
      () =>
        !!window.replacementBody.mesh.parent &&
        window.replacementBody.body.isValid(),
    ),
  ).toBe(true);
  expect(await page.locator('#undo').getAttribute('title')).toBe(state.undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(state.redo);
  await expect(page.locator('[data-prop="2"]')).toHaveClass(/selected/);
  await expect(page.locator('#resolution-label')).toHaveText('64 × 64');
  expect(await save(page, info, name)).toEqual(state.baseline);
}
async function failed(
  page,
  info,
  state,
  stage,
  action,
  failAt,
  candidateLength,
) {
  await arm(page, stage, failAt, candidateLength);
  await action();
  await expect(page.locator('#preparation-status')).toBeHidden();
  await expect(page.locator('#toast')).toContainText(
    'The previous scene was kept',
  );
  const fault = await page.evaluate(() => window.lastReplacementFault);
  expect(fault.stage).toBe(stage);
  // Keep the allocation broken during the visual check: recovery must not rebuild the old scene.
  expect(await capture(page)).toBe(state.pixels);
  await arm(page);
  await assertKept(page, info, state, stage + '-failed');
  return {
    ...fault,
    exactPixelsIncludingPhysicsBodyDataHistoryAndSelection: true,
  };
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
async function undoRedo(page, info, before, after) {
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, info, 'undone')).toEqual(before);
  await page.locator('#redo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, info, 'redone')).toEqual(after);
}
function generatedDocument(baseline, resolution, seed, preset) {
  const expected = createProject(resolution, baseline.size, seed);
  generateTerrain(expected, preset);
  return {
    ...structuredClone(baseline),
    resolution,
    seed,
    heights: Array.from(expected.heights),
    holes: Array.from(expected.holes),
    paint: Array.from(expected.paint),
    foliage: [],
    props: [],
  };
}

test('regeneration stages the replacement grid and retains reusable authoring settings, redo and live physics on failure', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info),
    evidence = [];
  await (await inspectorControl(page, '#preset')).selectOption('dunes');
  await (await inspectorControl(page, '#resolution')).selectOption('128');
  for (const seed of ['', '1.5', '2147483648']) {
    await number(page, 'seed', seed);
    await (await inspectorControl(page, '#generate')).click();
    await expect(page.locator('#toast')).toContainText(
      'Seed must be an integer',
    );
    await assertKept(page, info, state, 'invalid-seed-' + (seed || 'empty'));
  }
  await number(page, 'seed', 0);
  for (const [stage, at] of [
    ['candidate', 1],
    ['terrain', 3],
    ['picking', 2],
    ['colliders', 2],
    ['history', 1],
  ])
    evidence.push(
      await failed(
        page,
        info,
        state,
        stage,
        async () => (await inspectorControl(page, '#generate')).click(),
        at,
        16641,
      ),
    );
  await page.evaluate(() => {
    document.querySelector('#generate').click();
    document.querySelector('#cancel-preparation').click();
  });
  await expect(page.locator('#preparation-status')).toBeHidden();
  await assertKept(page, info, state, 'cancelled');
  expect(decodeDocument(Buffer.from(await autosave(page)))).toEqual(
    state.baseline,
  );
  await arm(page, 'maps');
  await (await inspectorControl(page, '#generate')).click();
  await expect(page.locator('#toast')).toContainText('Landscape generated');
  const allocations = await page.evaluate(() => ({
    ...window.replacementAllocations,
  }));
  expect(allocations.maps ?? 0).toBe(0);
  expect(
    await page.evaluate(() => window.lastReplacementFault),
  ).toBeUndefined();
  await arm(page);
  expect(
    await page.evaluate(
      () =>
        window.replacementBody.mesh.parent === null &&
        !window.replacementBody.body.isValid(),
    ),
  ).toBe(true);
  const expected = generatedDocument(state.baseline, 128, 0, 'dunes');
  expect(await save(page, info, 'generated')).toEqual(expected);
  await expect(page.locator('#resolution-label')).toHaveText('128 × 128');
  await expect(page.locator('[data-prop]')).toHaveCount(0);
  await undoRedo(page, info, state.baseline, expected);
  await page.locator('[data-tab="foliage"]').click();
  await expect(page.locator('#brush-name')).toHaveValue(
    'Imported planting mix',
  );
  await (await inspectorControl(page, '#populate')).click();
  await expect(page.locator('#toast')).toContainText('instances placed');
  const planted = await save(page, info, 'reused-brush');
  expect(planted.foliage.length).toBeGreaterThan(0);
  expect(Math.min(...planted.foliage.map((f) => f.id))).toBe(91);
  expect(planted.assets).toEqual(expected.assets);
  expect(planted.brushes).toEqual(expected.brushes);
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, info, 'reused-brush-undone')).toEqual(expected);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.locator('[data-tab="sculpt"]').click();
  await (await inspectorControl(page, '#generate')).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('regenerated-landscape.png') });
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(expected.name);
  expect(await save(page, info, 'reopened')).toEqual(expected);
  expect(state.errors).toEqual([]);
  await writeFile(
    info.outputPath('generation-recovery.json'),
    JSON.stringify(
      {
        evidence,
        allocations,
        invalidSeeds: 3,
        zeroSeedAndGridChange: true,
        unchangedCommittedAutosave: true,
        retainedAndReusedBrushAssetsAndSettings: true,
        earlyCancellation: true,
        retryUndoRedoAndReload: true,
        errors: state.errors,
      },
      null,
      2,
    ),
  );
});

test('heightmap replacement preserves the complete old scene until anchors and collision are ready and discards cancelled or superseded reads', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info),
    evidence = [];
  await number(page, 'heightmap-min', -4);
  await number(page, 'heightmap-max', 12);
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByText('RAW16 options', { exact: true }).click();
  await number(page, 'raw-width', 2);
  await number(page, 'raw-height', 2);
  const bytes = Buffer.alloc(8);
  [0, 16384, 32768, 65535].forEach((v, i) => bytes.writeUInt16LE(v, i * 2));
  const load = (name = 'height.r16', buffer = bytes) =>
    page
      .locator('#heightmap-open')
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  for (const [stage, at] of [
    ['candidate', 1],
    ['terrain', 3],
    ['foliage', 1],
    ['picking', 2],
    ['colliders', 2],
    ['history', 1],
  ])
    evidence.push(
      await failed(page, info, state, stage, () => load(), at, 4225),
    );
  await load('broken.r16', Buffer.alloc(4));
  await expect(page.locator('#toast')).toContainText(
    'RAW16 dimensions must match',
  );
  await assertKept(page, info, state, 'invalid-file');
  await load('held.r16');
  await page.waitForFunction(() => !!window.releaseHeightmapRead);
  await expect(page.locator('#preparation-status')).toContainText(
    'Importing heightmap',
  );
  await page.locator('#cancel-preparation').click();
  await page.evaluate(() => {
    window.releaseHeightmapRead();
    window.releaseHeightmapRead = undefined;
  });
  await expect(page.locator('#preparation-status')).toBeHidden();
  await assertKept(page, info, state, 'cancelled-read');
  expect(decodeDocument(Buffer.from(await autosave(page)))).toEqual(
    state.baseline,
  );
  await arm(page, 'maps');
  await load();
  await expect(page.locator('#toast')).toContainText(
    'Heightmap imported: 2 × 2, resampled to 65 × 65',
  );
  const allocations = await page.evaluate(() => ({
    ...window.replacementAllocations,
  }));
  expect(allocations.maps ?? 0).toBe(0);
  expect(
    await page.evaluate(() => window.lastReplacementFault),
  ).toBeUndefined();
  await arm(page);
  expect(
    await page.evaluate(
      () =>
        window.replacementBody.mesh.parent === null &&
        !window.replacementBody.body.isValid(),
    ),
  ).toBe(true);
  const expected = structuredClone(state.baseline);
  const candidate = createProject(64, 64);
  applyHeightmap(
    candidate,
    decodeRaw16(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      2,
      2,
    ),
    -4,
    12,
  );
  expected.heights = Array.from(candidate.heights);
  expect(await save(page, info, 'heightmap-retried')).toEqual(expected);
  await expect(page.locator('[data-prop="2"]')).toHaveClass(/selected/);
  await undoRedo(page, info, state.baseline, expected);
  // A new landscape supersedes a pending read even when that read later completes successfully.
  await load('held.r16');
  await page.waitForFunction(() => !!window.releaseHeightmapRead);
  await (await inspectorControl(page, '#preset')).selectOption('flat');
  await (await inspectorControl(page, '#resolution')).selectOption('32');
  await number(page, 'seed', 17);
  await (await inspectorControl(page, '#generate')).click();
  await expect(page.locator('#toast')).toContainText('Landscape generated');
  await page.evaluate(() => window.releaseHeightmapRead());
  await expect(page.locator('#preparation-status')).toBeHidden();
  const generated = generatedDocument(expected, 32, 17, 'flat');
  expect(await save(page, info, 'superseded-read')).toEqual(generated);
  await page.locator('#undo').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  expect(await save(page, info, 'supersession-undone')).toEqual(expected);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await (
    await inspectorControl(page, '#import-heightmap')
  ).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('imported-landscape.png') });
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(expected.name);
  expect(await save(page, info, 'reopened')).toEqual(expected);
  expect(state.errors).toEqual([]);
  await writeFile(
    info.outputPath('heightmap-recovery.json'),
    JSON.stringify(
      {
        evidence,
        allocations,
        unchangedCommittedAutosave: true,
        cancelledRead: true,
        supersededReadAndOneStepUndo: true,
        retryUndoRedoAndReload: true,
        errors: state.errors,
      },
      null,
      2,
    ),
  );
});
