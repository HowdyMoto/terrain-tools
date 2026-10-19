import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import {
  createProject,
  generateTerrain,
  serializeProject,
  effectiveHoles,
  parseProject,
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
  const box = await page.locator('#viewport canvas').boundingBox();
  // Clear a hovered transform axis before comparing the committed scene.
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.2);
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
async function arm(page, stage) {
  await page.evaluate((stage) => {
    window.propFault = stage;
    window.lastPropFault = undefined;
  }, stage);
}
async function range(page, selector, value) {
  await page.locator(selector).evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function setup(page, info) {
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
            /\/assets\/terrain-scene-[\w-]+\.js/.test(new Error().stack)
          ) {
            if (n >= 16 && n % 16 === 0 && n !== 288) stage = 'foliage';
            if (n === 72) stage = 'prop-collision';
          }
          if (stage && stage === window.propFault) {
            window.lastPropFault = stage;
            throw new RangeError('Injected prop ' + stage + ' failure');
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
  generateTerrain(project, 'flat');
  project.name = 'Prop recovery baseline';
  project.view.textureResolution = 256;
  project.view.water = false;
  project.wind.enabled = false;
  project.foliage = [
    { id: 10, brushId: 'grass', x: 10, z: 10, scale: 1, rotation: 0 },
    { id: 11, brushId: 'grass', x: 12, z: 10, scale: 1, rotation: 0 },
  ];
  project.props = [
    {
      id: 1,
      model: 'platform',
      x: 0,
      z: 0,
      yOffset: 2,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 3,
      cutout: {
        shape: 'rectangle',
        width: 10,
        depth: 6,
        offsetX: 1,
        offsetZ: -1,
      },
    },
    {
      id: 2,
      model: 'portal',
      x: -12,
      z: -8,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 3,
    },
  ];
  project.holes[0] = 1;
  project.nextId = 12;
  await page.locator('#file-open').setInputFiles({
    name: 'prop-recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await page.locator('#frame').click();
  await page.locator('#physics').click();
  await expect(page.locator('#physics-state')).toHaveText(
    'Terrain collision active',
  );
  await page.locator('[data-tab="props"]').click();
  await page.locator('[data-prop="1"]').click();
  await page.locator('#project-name').fill('Redo branch');
  await page.locator('#project-name').press('Tab');
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(project.name);
  await expect(page.locator('#redo')).toBeEnabled();
  await page.locator('[data-prop="1"]').click();
  const baseline = await save(page, info, 'baseline');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const undo = await page.locator('#undo').getAttribute('title'),
    redo = await page.locator('#redo').getAttribute('title');
  const box = await page.locator('#viewport canvas').boundingBox();
  const camera = new THREE.PerspectiveCamera(
    45,
    box.width / box.height,
    0.1,
    3000,
  );
  const halfH = Math.atan(Math.tan(Math.PI / 8) * camera.aspect),
    distance = (project.size * 0.72) / Math.sin(Math.min(Math.PI / 8, halfH));
  camera.position.copy(
    new THREE.Vector3(1, 0.87, 1)
      .normalize()
      .multiplyScalar(distance)
      .add(new THREE.Vector3(0, 8, 0)),
  );
  camera.lookAt(0, 8, 0);
  camera.updateMatrixWorld(true);
  const point = (value) => {
    const p = new THREE.Vector3(...value).project(camera);
    return {
      x: box.x + ((p.x + 1) * box.width) / 2,
      y: box.y + ((1 - p.y) * box.height) / 2,
    };
  };
  const handle =
    (camera.position.distanceTo(new THREE.Vector3(0, 2, 0)) *
      1.9 *
      Math.tan(Math.PI / 8) *
      0.85) /
    4;
  return { baseline, errors, undo, redo, point, handle };
}
async function unchanged(page, info, state, pixels, name, selection = 1) {
  await expect(page.locator('#toast')).toContainText(
    'The previous scene was restored',
  );
  await expect.poll(() => capture(page), { message: name }).toBe(pixels);
  expect(await page.locator('#undo').getAttribute('title')).toBe(state.undo);
  expect(await page.locator('#redo').getAttribute('title')).toBe(state.redo);
  await page.getByRole('tab', { name: 'Selected', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Selected prop #' + selection,
      exact: true,
    }),
  ).toBeVisible();
  const fault = await page.evaluate(() => window.lastPropFault);
  await arm(page, undefined);
  expect(await save(page, info, name)).toEqual(state.baseline);
  return fault;
}

test('prop placement, numeric edits, cutouts and removal recover without changing selection, ids, history or autosave', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const state = await setup(page, info),
    evidence = [];
  const pixels = await capture(page);
  for (const stage of [
    'foliage',
    'terrain',
    'picking',
    'prop-collision',
    'collision',
    'history',
  ]) {
    await arm(page, stage);
    await range(page, '#prop-x', 6);
    expect(await unchanged(page, info, state, pixels, 'numeric-' + stage)).toBe(
      stage,
    );
    await expect(page.locator('#prop-x')).toHaveValue('0');
    evidence.push({ action: 'numeric-x', stage, exactRestore: true });
  }
  const actions = [
    ['position-z', 'history', () => range(page, '#prop-z', 6)],
    ['height', 'collision', () => range(page, '#prop-y', 5)],
    ['scale', 'terrain', () => range(page, '#prop-scale', 2)],
    ['rotation', 'picking', () => range(page, '#prop-rotation', 45)],
    [
      'cut-enabled',
      'history',
      async () => (await inspectorControl(page, '#selected-cut')).click(),
    ],
    [
      'shape',
      'terrain',
      async () =>
        (await inspectorControl(page, '#cutout-shape')).selectOption('circle'),
    ],
    [
      'model-bounds',
      'collision',
      async () => (await inspectorControl(page, '#fit-prop-cutout')).click(),
    ],
    ...[
      ['width', '12'],
      ['depth', '9'],
      ['offset-x', '4'],
      ['offset-z', '3'],
    ].map(([key, value]) => [
      'cutout-' + key,
      'history',
      async () => {
        await (await inspectorControl(page, '#cutout-' + key)).fill(value);
        await (await inspectorControl(page, '#cutout-' + key)).press('Tab');
      },
    ]),
    [
      'delete',
      'collision',
      async () => (await inspectorControl(page, '#delete-prop')).click(),
    ],
  ];
  for (const [action, stage, perform] of actions) {
    await arm(page, stage);
    await perform();
    expect(await unchanged(page, info, state, pixels, action + '-failed')).toBe(
      stage,
    );
    if (action === 'cut-enabled')
      await expect(page.locator('#selected-cut')).toBeChecked();
    evidence.push({ action, stage, exactRestore: true });
  }
  const saved = await page.evaluate(async () => {
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
  expect(decodeDocument(Buffer.from(saved))).toEqual(state.baseline);
  await page.locator('[data-prop="2"]').click();
  const circlePixels = await capture(page);
  await arm(page, 'history');
  await range(page, '#selected-radius', 6);
  expect(
    await unchanged(page, info, state, circlePixels, 'circle-radius-failed', 2),
  ).toBe('history');
  await expect(page.locator('#selected-radius')).toHaveValue('3');
  evidence.push({
    action: 'circle-radius',
    stage: 'history',
    exactRestore: true,
  });
  await page.locator('[data-prop="1"]').click();
  await (await inspectorControl(page, '#prop-model')).selectOption('platform');
  await (await inspectorControl(page, '#prop-cut')).check();
  await (await inspectorControl(page, '#prop-footprint')).selectOption('model');
  await (await inspectorControl(page, '#place-prop')).click();
  const placementPixels = await capture(page),
    position = state.point([20, 0, -10]);
  await arm(page, 'history');
  await page.mouse.click(position.x, position.y);
  expect(
    await unchanged(page, info, state, placementPixels, 'placement-failed'),
  ).toBe('history');
  evidence.push({ action: 'placement', stage: 'history', exactRestore: true });
  await page.mouse.click(position.x, position.y);
  const placed = await save(page, info, 'placed');
  expect(placed.props).toHaveLength(3);
  expect(placed.props[2]).toMatchObject({
    id: 12,
    model: 'platform',
    cutHole: true,
    cutout: { shape: 'rectangle', width: 7, depth: 5 },
  });
  expect(placed.nextId).toBe(13);
  expect(effectiveHoles(parseProject(JSON.stringify(placed)))).not.toEqual(
    effectiveHoles(parseProject(JSON.stringify(state.baseline))),
  );
  await expect(page.locator('#redo')).toBeDisabled();
  await page.locator('#undo').click();
  expect(await save(page, info, 'placement-undone')).toEqual(state.baseline);
  await page.locator('#redo').click();
  expect(await save(page, info, 'placement-redone')).toEqual(placed);
  await page.locator('[data-prop="12"]').click();
  await (await inspectorControl(page, '#delete-prop')).click();
  const removed = await save(page, info, 'removed');
  expect(removed.props).toEqual(state.baseline.props);
  expect(effectiveHoles(parseProject(JSON.stringify(removed)))).toEqual(
    effectiveHoles(parseProject(JSON.stringify(state.baseline))),
  );
  await page.locator('#undo').click();
  expect(await save(page, info, 'removal-undone')).toEqual(placed);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(placed.name);
  expect(await save(page, info, 'reopened')).toEqual(placed);
  expect(state.errors).toEqual([]);
  await writeFile(
    info.outputPath('prop-recovery.json'),
    JSON.stringify(
      {
        evidence,
        committedIndexedDBBlobUnchangedAfterFailures: true,
        placementAndRemovalRetry: true,
        exactUndoRedoAndAutosave: true,
        errors: state.errors,
      },
      null,
      2,
    ),
  );
});

test('failed handle commits restore the displayed prop as well as terrain and cutouts, then retry as one undo step', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const state = await setup(page, info),
    evidence = [];
  const drag = async (mode) => {
    const h = state.handle,
      r = h * 0.5;
    const from = state.point(
      mode === 'rotate'
        ? [r, 2, 0]
        : mode === 'scale'
          ? [0, 2 + h * 0.45, 0]
          : [h * 0.45, 2, 0],
    );
    const to = state.point(
      mode === 'rotate'
        ? [r * Math.SQRT1_2, 2, r * Math.SQRT1_2]
        : mode === 'scale'
          ? [0, 2 + h * 0.8, 0]
          : [h * 0.45 + 6, 2, 0],
    );
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await expect(page.locator('#prop-transform-hint')).toContainText(
      'Release to apply',
    );
    await page.mouse.move(to.x, to.y, { steps: 10 });
  };
  for (const [stage, mode] of [
    ['foliage', 'translate'],
    ['terrain', 'rotate'],
    ['picking', 'scale'],
    ['prop-collision', 'translate'],
    ['collision', 'rotate'],
    ['history', 'scale'],
  ]) {
    await page.locator('[data-prop-transform="' + mode + '"]').click();
    const pixels = await capture(page);
    await drag(mode);
    if (stage === 'foliage')
      await page.screenshot({
        path: info.outputPath('handle-preview.png'),
        fullPage: true,
      });
    await arm(page, stage);
    await page.mouse.up();
    await expect(page.locator('#prop-transform-hint')).toContainText(
      'Drag a handle',
    );
    expect(await unchanged(page, info, state, pixels, mode + '-' + stage)).toBe(
      stage,
    );
    evidence.push({ mode, stage, exactRestore: true });
  }
  await page.locator('[data-prop-transform="translate"]').click();
  await (await inspectorControl(page, '#prop-snap')).check();
  await drag('translate');
  await page.mouse.up();
  const moved = await save(page, info, 'moved');
  expect(moved.props[0].x).toBeCloseTo(6, 5);
  expect(moved.props[0].cutout).toEqual(state.baseline.props[0].cutout);
  await expect(page.locator('#redo')).toBeDisabled();
  await page.locator('#undo').click();
  expect(await save(page, info, 'undone')).toEqual(state.baseline);
  await page.locator('#redo').click();
  expect(await save(page, info, 'redone')).toEqual(moved);
  await page.screenshot({
    path: info.outputPath('handle-retried.png'),
    fullPage: true,
  });
  expect(state.errors).toEqual([]);
  await writeFile(
    info.outputPath('handle-recovery.json'),
    JSON.stringify(
      { evidence, retryUndoRedo: true, errors: state.errors },
      null,
      2,
    ),
  );
});
