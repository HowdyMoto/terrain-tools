import { inspectorControl } from './inspector-controls.mjs';
import { decodeDocument } from './fixtures.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import {
  createProject,
  generateTerrain,
  serializeProject,
  parseProject,
  effectiveHoles,
} from 'terrain-tools';
import { triangleGlb } from './fixtures.mjs';

async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = info.outputPath(name);
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function cameraProjection(page, size) {
  const box = await page
    .getByLabel('Interactive terrain viewport')
    .boundingBox();
  const camera = new THREE.PerspectiveCamera(
    45,
    box.width / box.height,
    0.1,
    3000,
  );
  const halfV = Math.PI / 8,
    halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  const distance = (size * 0.72) / Math.sin(Math.min(halfV, halfH));
  camera.position.copy(
    new THREE.Vector3(1, 0.87, 1)
      .normalize()
      .multiplyScalar(distance)
      .add(new THREE.Vector3(0, 8, 0)),
  );
  camera.lookAt(0, 8, 0);
  camera.updateMatrixWorld(true);
  return {
    point(value) {
      const p = new THREE.Vector3(...value).project(camera);
      return {
        x: box.x + ((p.x + 1) * box.width) / 2,
        y: box.y + ((1 - p.y) * box.height) / 2,
      };
    },
    handleSize(origin) {
      return (
        (camera.position.distanceTo(new THREE.Vector3(...origin)) *
          1.9 *
          Math.tan(Math.PI / 8) *
          0.85) /
        4
      );
    },
  };
}
async function gesture(page, projection, start, finish, cancel = false) {
  const from = projection.point(start),
    to = projection.point(finish);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await expect(page.locator('#prop-transform-hint')).toContainText(
    'Release to apply',
  );
  await page.mouse.move(to.x, to.y, { steps: 10 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('#prop-transform-hint')).toContainText(
    'Drag a handle',
  );
}

test('selects offset meshes, transforms with one-step history, and preserves fitted cutouts in editor and runtime', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /Shader|WebGL/.test(message.text()))
      errors.push(message.text());
  });
  const p = createProject(32, 64);
  generateTerrain(p, 'flat');
  p.name = 'Prop handles and footprints';
  p.view.water = false;
  p.view.textureResolution = 256;
  p.assets = {
    'asset-marker': {
      name: 'Off-centre marker.glb',
      data:
        'data:model/gltf-binary;base64,' +
        triangleGlb({ translation: [10, 0, 3] }).toString('base64'),
    },
  };
  p.props = [
    {
      id: 1,
      model: 'asset-marker',
      x: -8,
      z: -3,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 3,
    },
    {
      id: 2,
      model: 'boulder',
      x: 4,
      z: 0,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: false,
      holeRadius: 2,
    },
  ];
  p.nextId = 3;
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  await page.locator('#file-open').setInputFiles({
    name: 'props.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(p)),
  });
  await expect(page.locator('#project-name')).toHaveValue(p.name);
  await page.getByLabel('Interactive terrain viewport').focus();
  await page.keyboard.press('f');
  await page.locator('[data-tab="props"]').click();
  await (await inspectorControl(page, '#select-prop')).click();
  const projection = await cameraProjection(page, p.size),
    pick = projection.point([2, 3, 0]);
  await page.mouse.click(pick.x, pick.y);
  await expect(
    page.getByRole('heading', { name: 'Selected prop #1' }),
  ).toBeVisible();
  await expect(page.locator('#prop-transform-tools')).toBeVisible();
  await (await inspectorControl(page, '#fit-prop-cutout')).click();
  await expect(page.locator('#cutout-width')).toHaveValue('4');
  await expect(page.locator('#cutout-depth')).toHaveValue('2');
  await expect(page.locator('#cutout-offset-x')).toHaveValue('10');
  await expect(page.locator('#cutout-offset-z')).toHaveValue('3');
  await page.locator('#cutout-width').fill('10');
  await page.locator('#cutout-width').press('Tab');
  await page.locator('#cutout-depth').fill('4');
  await page.locator('#cutout-depth').press('Tab');
  const before = await save(page, info, 'before-transform.json');
  await page.locator('#cutout-width').fill('-1');
  await page.locator('#cutout-width').press('Tab');
  await expect(page.locator('#toast')).toContainText(
    'Invalid prop cutout width',
  );
  expect(await save(page, info, 'invalid-footprint.json')).toEqual(before);
  await (await inspectorControl(page, '#prop-snap')).check();
  const origin = [-8, 0, -3],
    handle = projection.handleSize(origin) * 0.45;
  await gesture(
    page,
    projection,
    [origin[0] + handle, 0, -3],
    [origin[0] + handle + 5.5, 0, -3],
  );
  const moved = await save(page, info, 'moved.json');
  expect(moved.props[0].x).toBeCloseTo(-2.5, 5);
  expect(moved.props[0].z).toBe(-3);
  expect(moved.props[0].yOffset).toBe(0);
  expect(moved.props[0].cutout).toEqual(before.props[0].cutout);
  await page.locator('#undo').click();
  await expect(page.locator('#prop-x')).toHaveValue('-8');
  expect(await save(page, info, 'undo-move.json')).toEqual(before);
  await page.locator('#redo').click();
  await expect(page.locator('#prop-x')).toHaveValue('-2.5');
  const movedOrigin = [-2.5, 0, -3],
    nextHandle = projection.handleSize(movedOrigin) * 0.45;
  await gesture(
    page,
    projection,
    [-2.5 + nextHandle, 0, -3],
    [-2.5 + nextHandle + 8, 0, -3],
    true,
  );
  expect(await save(page, info, 'cancelled-transform.json')).toEqual(moved);
  // Cancellation must not create an extra history entry.
  await page.locator('#undo').click();
  await expect(page.locator('#prop-x')).toHaveValue('-8');
  expect(await save(page, info, 'undo-after-cancel.json')).toEqual(before);
  await page.locator('#redo').click();
  await expect(page.locator('#prop-x')).toHaveValue('-2.5');
  await page.locator('[data-prop-transform="rotate"]').click();
  const ring = projection.handleSize(movedOrigin) * 0.5;
  await gesture(
    page,
    projection,
    [-2.5 + ring, 0, -3],
    [-2.5 + ring * Math.SQRT1_2, 0, -3 + ring * Math.SQRT1_2],
  );
  const rotated = await save(page, info, 'rotated.json');
  expect(Math.abs(rotated.props[0].rotation)).toBeGreaterThan(0.1);
  expect(rotated.props[0].rotation / (Math.PI / 12)).toBeCloseTo(
    Math.round(rotated.props[0].rotation / (Math.PI / 12)),
    5,
  );
  await page.locator('[data-prop-transform="scale"]').click();
  const scaleHandle = projection.handleSize(movedOrigin) * 0.45;
  await gesture(
    page,
    projection,
    [-2.5, scaleHandle, -3],
    [-2.5, scaleHandle * 1.8, -3],
  );
  const scaled = await save(page, info, 'scaled.json');
  expect(scaled.props[0].scale).toBeGreaterThan(1.2);
  expect(scaled.props[0].scale * 10).toBeCloseTo(
    Math.round(scaled.props[0].scale * 10),
    5,
  );
  expect(scaled.props[0].cutout).toEqual(before.props[0].cutout);
  await (await inspectorControl(page, '#prop-model')).selectOption('platform');
  await (await inspectorControl(page, '#prop-footprint')).selectOption('model');
  await (await inspectorControl(page, '#prop-cut')).check();
  await (await inspectorControl(page, '#place-prop')).click();
  const place = projection.point([-18, 0, 10]);
  await page.mouse.click(place.x, place.y);
  const authored = await save(page, info, 'authored.json');
  expect(authored.props).toHaveLength(3);
  expect(authored.props[2].cutout).toEqual({
    shape: 'rectangle',
    width: 7,
    depth: 5,
    offsetX: 0,
    offsetZ: 0,
  });
  await expect(page.locator('#prop-transform-tools')).toBeVisible();
  await page.screenshot({ path: info.outputPath('prop-authoring.png') });
  const pending = page.waitForEvent('download');
  await page.locator('#export').click();
  const glb = info.outputPath('props.glb');
  await (await pending).saveAs(glb);
  const bytes = await readFile(glb),
    json = decodeDocument(
      bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString(),
    );
  const terrainNode = json.nodes.find((node) => node.name === 'Terrain 0,0'),
    terrainMesh = json.meshes[terrainNode.mesh];
  const holes = effectiveHoles(parseProject(JSON.stringify(authored))).reduce(
    (a, b) => a + b,
    0,
  );
  expect(json.accessors[terrainMesh.primitives[0].indices].count).toBe(
    (32 * 32 - holes) * 6,
  );
  await page.locator('#file-open').setInputFiles(glb);
  await expect(page.locator('#toast')).toHaveText('Project loaded.');
  expect(await save(page, info, 'reopened.json')).toEqual(authored);
  const runtime = await context.newPage();
  runtime.on('pageerror', (error) => errors.push(error.message));
  await runtime.goto('/runtime.html');
  await expect(runtime.locator('#status')).toContainText('foliage instances', {
    timeout: 30000,
  });
  await runtime.locator('#open-project').setInputFiles(glb);
  await expect(runtime.locator('#status')).toContainText(p.name);
  await expect(runtime.locator('#status')).toContainText('3 props');
  await runtime.close();
  // A project replacement must not leave an imported placement model dangling.
  await (
    await inspectorControl(page, '#prop-model')
  ).selectOption('asset-marker');
  const cleared = {
    ...authored,
    assets: {},
    props: [],
    name: 'Cleared prop assets',
  };
  await page.locator('#file-open').setInputFiles({
    name: 'cleared.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(cleared)),
  });
  await expect(page.locator('#project-name')).toHaveValue(cleared.name);
  await expect(page.locator('#prop-model')).toHaveValue('boulder');
  await (await inspectorControl(page, '#place-prop')).click();
  const replacementPlace = projection.point([-12, 0, -12]);
  await page.mouse.click(replacementPlace.x, replacementPlace.y);
  const replaced = await save(page, info, 'replacement-placement.json');
  expect(replaced.props[0].model).toBe('boulder');
  expect(() => parseProject(JSON.stringify(replaced))).not.toThrow();
  expect(errors).toEqual([]);
});
