import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createProject,
  generateTerrain,
  serializeProject,
} from 'terrain-tools';
import { decodeDocument } from './fixtures.mjs';
import { runtimePackagePage } from './runtime-package-page.mjs';

async function save(page, testInfo, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const path = testInfo.outputPath(name);
  await (await pending).saveAs(path);
  return decodeDocument(await readFile(path));
}
async function open(page, project) {
  await page.locator('#file-open').setInputFiles({
    name: 'rebuild.terrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
}
test('failed runtime rebuild keeps rendered pixels and GPU geometry intact, then retries', async ({
  page,
}, testInfo) => {
  await runtimePackagePage(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { TerrainScene } = await import('/__runtime_test/lib/runtime.js');
    const { createProject, generateTerrain } =
      await import('/__runtime_test/lib/core.js');
    const p = createProject(64, 64);
    generateTerrain(p, 'flat');
    p.view.water = false;
    p.wind.enabled = false;
    p.foliage = [
      { id: 1, brushId: 'pine', x: -10, z: 5, scale: 1, rotation: 0 },
    ];
    p.props = [
      {
        id: 2,
        model: 'platform',
        x: 8,
        z: 0,
        yOffset: 2,
        scale: 1,
        rotation: 0,
        cutHole: false,
        holeRadius: 3,
      },
    ];
    const terrain = new TerrainScene(p);
    await terrain.load(p, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#426080');
    scene.overrideMaterial = new THREE.MeshNormalMaterial();
    scene.add(terrain);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
    camera.position.set(75, 70, 75);
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(256, 256);
    document.body.append(renderer.domElement);
    const pixels = () => {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL();
    };
    const baseline = pixels(),
      geometryCount = renderer.info.memory.geometries;
    const meshes = [...terrain.terrain.children],
      foliage = [...terrain.foliage.children],
      props = [...terrain.props.children];
    const original = THREE.BufferGeometry.prototype.computeBoundingBox;
    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      let calls = 0;
      THREE.BufferGeometry.prototype.computeBoundingBox = function () {
        if (++calls === 3)
          throw new RangeError('Injected candidate geometry failure');
        return original.call(this);
      };
      const candidate = structuredClone(p);
      candidate.heights.fill(10);
      let failed = false;
      try {
        await terrain.load(candidate, false);
      } catch (error) {
        failed = error.message.includes('Injected candidate');
      } finally {
        THREE.BufferGeometry.prototype.computeBoundingBox = original;
      }
      attempts.push({
        failed,
        calls,
        samePixels: pixels() === baseline,
        geometryCount: renderer.info.memory.geometries,
        sameProject: terrain.project === p,
        sameMeshes: meshes.every(
          (mesh, i) => terrain.terrain.children[i] === mesh,
        ),
        sameFoliage: foliage.every(
          (mesh, i) => terrain.foliage.children[i] === mesh,
        ),
        sameProps: props.every((mesh, i) => terrain.props.children[i] === mesh),
      });
    }
    const candidate = structuredClone(p);
    candidate.heights.fill(10);
    await terrain.load(candidate, false);
    const changedPixels = pixels() !== baseline,
      propHeight = terrain.props.children[0].position.y;
    scene.remove(terrain);
    terrain.dispose();
    renderer.render(scene, camera);
    const remainingGeometry = renderer.info.memory.geometries;
    scene.overrideMaterial.dispose();
    renderer.dispose();
    return {
      attempts,
      geometryCount,
      changedPixels,
      propHeight,
      remainingGeometry,
    };
  });
  for (const attempt of result.attempts)
    expect(attempt).toEqual({
      failed: true,
      calls: 3,
      samePixels: true,
      geometryCount: result.geometryCount,
      sameProject: true,
      sameMeshes: true,
      sameFoliage: true,
      sameProps: true,
    });
  await writeFile(
    testInfo.outputPath('runtime-recovery.json'),
    JSON.stringify(result, null, 2),
  );
  expect(result.changedPixels).toBe(true);
  expect(result.propHeight).toBe(12);
  expect(result.remainingGeometry).toBe(0);
  expect(errors).toEqual([]);
});

test('editor preserves project and history after terrain, picking, and collision allocation failures', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['Float32Array', 'Uint32Array']) {
      const Original = window[name];
      window[name] = new Proxy(Original, {
        construct(target, args, constructor) {
          const fault = window.allocationFault;
          if (
            fault?.name === name &&
            args[0] === fault.length &&
            ++fault.calls === fault.failAt
          ) {
            window.allocationFault = undefined;
            window.lastAllocationFault = { ...fault };
            throw new RangeError(
              'Injected ' + fault.label + ' allocation failure',
            );
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
  const fixture = createProject(64, 64);
  generateTerrain(fixture, 'flat');
  fixture.name = 'Recoverable scene';
  fixture.view.textureResolution = 256;
  fixture.wind.enabled = false;
  fixture.view.water = false;
  fixture.foliage = [
    { id: 1, brushId: 'grass', x: -4, z: -4, scale: 1, rotation: 0 },
  ];
  fixture.props = [
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
  fixture.nextId = 3;
  await open(page, JSON.parse(serializeProject(fixture)));
  await expect(page.locator('#project-name')).toHaveValue(fixture.name);
  await page.locator('#physics').click();
  await expect(page.locator('#physics-state')).toHaveText(
    'Terrain collision active',
    { timeout: 30000 },
  );
  const baseline = await save(page, testInfo, 'baseline.terrain');
  const capture = () =>
    page.locator('#viewport canvas').evaluate(async (canvas) => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return canvas.toDataURL();
    });
  const baselinePixels = await capture();
  const candidate = structuredClone(baseline);
  candidate.name = 'Replacement succeeded';
  candidate.heights.fill(12);
  const beforeUndo = await page.locator('#undo').getAttribute('title'),
    beforeRedo = await page.locator('#redo').getAttribute('title');
  for (const fault of [
    { label: 'terrain', name: 'Float32Array', length: 3267, failAt: 3 },
    { label: 'picking', name: 'Uint32Array', length: 6144, failAt: 2 },
    { label: 'collision', name: 'Float32Array', length: 3267, failAt: 10 },
  ]) {
    await page.evaluate((fault) => {
      window.allocationFault = { ...fault, calls: 0 };
      window.lastAllocationFault = undefined;
    }, fault);
    await open(page, candidate);
    await expect(page.locator('#toast')).toContainText(
      'Could not open project',
    );
    await expect(page.locator('#toast')).toContainText(
      'Injected ' + fault.label,
    );
    expect(await page.evaluate(() => window.lastAllocationFault.calls)).toBe(
      fault.failAt,
    );
    await expect(page.locator('#project-name')).toHaveValue(baseline.name);
    expect(await page.locator('#undo').getAttribute('title')).toBe(beforeUndo);
    expect(await page.locator('#redo').getAttribute('title')).toBe(beforeRedo);
    expect(
      await save(page, testInfo, fault.label + '-failure.terrain'),
    ).toEqual(baseline);
    expect(await capture()).toBe(baselinePixels);
    await expect(page.locator('#physics-state')).toHaveText(
      'Terrain collision active',
    );
  }
  // A subsequent valid open commits once, including render, picking and physics.
  await open(page, candidate);
  await expect(page.locator('#project-name')).toHaveValue(candidate.name);
  expect(await save(page, testInfo, 'retried.terrain')).toEqual(candidate);
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(baseline.name);
  expect(await save(page, testInfo, 'undone.terrain')).toEqual(baseline);
  // Failed redo must also leave both history stacks available.
  await page.evaluate(() => {
    window.allocationFault = {
      label: 'picking',
      name: 'Uint32Array',
      length: 6144,
      failAt: 2,
      calls: 0,
    };
  });
  const redoTitle = await page.locator('#redo').getAttribute('title');
  await page.locator('#redo').click();
  await expect(page.locator('#toast')).toContainText(
    'Could not restore history',
  );
  expect(await page.locator('#redo').getAttribute('title')).toBe(redoTitle);
  expect(await save(page, testInfo, 'failed-redo.terrain')).toEqual(baseline);
  await page.locator('#redo').click();
  await expect(page.locator('#project-name')).toHaveValue(candidate.name);
  expect(await save(page, testInfo, 'redone.terrain')).toEqual(candidate);
  await page.locator('#frame').click();
  await (await inspectorControl(page, '[data-tool="raise"]')).click();
  const bounds = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(
    bounds.x + bounds.width * 0.5,
    bounds.y + bounds.height * 0.55,
  );
  const edited = await save(page, testInfo, 'edited-after-recovery.terrain');
  expect(edited.heights.some((height) => height > 12)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('recovered-editor.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
