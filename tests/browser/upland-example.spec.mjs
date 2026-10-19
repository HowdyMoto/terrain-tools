import { inspectorControl } from './inspector-controls.mjs';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodeDocument } from './fixtures.mjs';
import { runtimePackagePage } from './runtime-package-page.mjs';

const folder = 'public/examples/upland/';
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /THREE|Shader|WebGL/i.test(message.text())
    )
      errors.push(message.text());
  });
  return errors;
}
async function save(page, testInfo, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const download = await pending;
  const path = testInfo.outputPath(name + '.terrain');
  await download.saveAs(path);
  return { path, document: decodeDocument(await readFile(path)) };
}

test('reference loading is cancellable, failure-safe, undoable and editable with offline native recovery', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors = watchErrors(page);
  const source = decodeDocument(
    await readFile(folder + 'upland-meadow.terrain'),
  );
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const before = await save(page, testInfo, 'before-reference');
  const historyBefore = await page.locator('#undo').getAttribute('title');
  const pattern = '**/examples/upland/upland-meadow.terrain';
  let release,
    requestSeen = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    requestSeen = true;
    await gate;
    await route.abort().catch(() => {});
  });
  await (await inspectorControl(page, '#open-upland')).click();
  await expect.poll(() => requestSeen).toBe(true);
  await expect(page.locator('#preparation-status')).toContainText(
    'Opening upland meadow',
  );
  await page.locator('#cancel-preparation').click();
  release();
  await page.unroute(pattern);
  expect(await page.locator('#undo').getAttribute('title')).toBe(historyBefore);
  expect((await save(page, testInfo, 'cancelled-reference')).document).toEqual(
    before.document,
  );

  await page.route(pattern, (route) =>
    route.fulfill({ status: 503, body: 'Unavailable fixture' }),
  );
  await (await inspectorControl(page, '#open-upland')).click();
  await expect(page.locator('#toast')).toContainText('503');
  expect(await page.locator('#undo').getAttribute('title')).toBe(historyBefore);
  await page.unroute(pattern);

  await (await inspectorControl(page, '#open-upland')).click();
  await expect(page.locator('#project-name')).toHaveValue(source.name, {
    timeout: 30000,
  });
  expect((await save(page, testInfo, 'loaded-reference')).document).toEqual(
    source,
  );
  const historyAfter = await page.locator('#undo').getAttribute('title');
  expect(Number(historyAfter.match(/(\d+) undo steps/)[1])).toBe(
    Number(historyBefore.match(/(\d+) undo steps/)[1]) + 1,
  );
  await page.screenshot({ path: testInfo.outputPath('upland-editor.png') });
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(before.document.name);
  expect((await save(page, testInfo, 'undo-reference')).document).toEqual(
    before.document,
  );
  await page.locator('#redo').click();
  await expect(page.locator('#project-name')).toHaveValue(source.name);

  await page.locator('[data-tab="materials"]').click();
  await page.locator('#roughness').evaluate((input) => {
    input.value = '0.75';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const edited = await save(page, testInfo, 'edited-reference');
  expect(edited.document.materials[0].roughness).toBe(0.75);
  expect(edited.document.assets).toEqual(source.assets);
  expect(edited.document.foliage).toEqual(source.foliage);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  // All source URLs are unavailable: autosave and a user file still contain their own assets.
  await page.route('**/examples/upland/**', (route) => route.abort());
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue(source.name, {
    timeout: 30000,
  });
  expect((await save(page, testInfo, 'autosaved-reference')).document).toEqual(
    edited.document,
  );
  await page.locator('#file-open').setInputFiles(edited.path);
  await expect(page.locator('#toast')).toHaveText('Project loaded.', {
    timeout: 30000,
  });
  expect((await save(page, testInfo, 'reopened-reference')).document).toEqual(
    edited.document,
  );
  expect(errors).toEqual([]);
});

test('reference preview and real imported cutouts render wind, contact and recovery through the public runtime', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors = watchErrors(page);
  const manifest = JSON.parse(await readFile(folder + 'manifest.json', 'utf8'));
  const bytes = await readFile(folder + 'upland-meadow.terrain');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    manifest.packageSha256,
  );
  await page.goto('/runtime.html?sample=upland');
  await expect(page.locator('#status')).toContainText(
    manifest.foliage.toLocaleString('en-US') + ' foliage',
    { timeout: 30000 },
  );
  await page.locator('#wind').click();
  for (const view of ['trail', 'overview', 'grass']) {
    await page.locator('#reference-view').selectOption(view);
    // Let the authored 0.35 second LOD fade finish before capturing the view.
    await page.waitForTimeout(500);
    await page.screenshot({
      path: testInfo.outputPath('upland-' + view + '.png'),
    });
  }
  const pending = page.waitForEvent('download');
  await page.locator('#reference-download').click();
  const downloaded = testInfo.outputPath('reference-download.terrain');
  await (await pending).saveAs(downloaded);
  expect(await readFile(downloaded)).toEqual(bytes);
  await page.locator('#sample').selectOption('stylized');
  await expect(page.locator('#status')).toContainText('Low-poly islands');
  await expect(page.locator('#reference-view')).toBeHidden();
  await expect(page.locator('#reference-download')).toBeHidden();

  await runtimePackagePage(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { heightAt } = await import('/__runtime_test/lib/core.js');
    const { loadTerrain } = await import('/__runtime_test/lib/runtime.js');
    const source = await (
      await fetch('/examples/upland/upland-meadow.terrain')
    ).arrayBuffer();
    const terrain = await loadTerrain(source);
    const project = terrain.project;
    project.wind.enabled = false;
    const models = Object.fromEntries(
      Object.keys(project.assets).map((id) => {
        const parts = terrain.library.get(id);
        return [
          id,
          {
            triangles: parts.reduce(
              (sum, p) =>
                sum +
                (p.geometry.index?.count ??
                  p.geometry.attributes.position.count) /
                  3,
              0,
            ),
            mapped: parts.every((p) => p.material.map?.image?.width === 1254),
            alphaTest: parts[0].material.alphaTest,
          },
        ];
      }),
    );
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(192, 192);
    const target = new THREE.WebGLRenderTarget(192, 192);
    const scene = new THREE.Scene();
    scene.add(terrain, new THREE.HemisphereLight(0xffffff, 0x566452, 2));
    const sun = new THREE.DirectionalLight(0xffefd4, 2);
    sun.position.set(4, 8, 3);
    scene.add(sun);
    const plant = project.foliage.reduce((best, f) =>
      Math.hypot(f.x + 11, f.z - 14) < Math.hypot(best.x + 11, best.z - 14)
        ? f
        : best,
    );
    const y = heightAt(project, plant.x, plant.z);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 300);
    camera.position.set(plant.x + 1.5, y + 1.2, plant.z + 2.5);
    camera.lookAt(plant.x, y + 0.45, plant.z);
    camera.updateMatrixWorld();
    const pixels = () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const data = new Uint8Array(192 * 192 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 192, 192, data);
      return data;
    };
    const difference = (a, b) =>
      a.reduce((count, value, i) => count + (value !== b[i] ? 1 : 0), 0);
    try {
      terrain.update(1, [], camera);
      const still = pixels();
      terrain.update(
        0.1,
        [{ x: plant.x, z: plant.z, radius: 2.5, strength: 1 }],
        camera,
      );
      const crushed = pixels();
      for (let i = 0; i < 240; i++) terrain.update(0.1, [], camera);
      const recovered = pixels();
      project.wind.enabled = true;
      terrain.update(0.5, [], camera);
      const wind = pixels();
      return {
        models,
        foliage: project.foliage.length,
        props: terrain.props.children.length,
        contactChangedChannels: difference(still, crushed),
        recoveredChangedChannels: difference(still, recovered),
        windChangedChannels: difference(still, wind),
      };
    } finally {
      terrain.dispose();
      target.dispose();
      renderer.dispose();
    }
  });
  expect(result.foliage).toBe(manifest.foliage);
  expect(result.props).toBe(manifest.props);
  for (const [id, model] of Object.entries(result.models)) {
    expect(model.triangles).toBe(manifest.models[id].triangles);
    expect(model.mapped).toBe(true);
    expect(model.alphaTest).toBe(id === 'upland-limestone' ? 0 : 0.45);
  }
  expect(result.contactChangedChannels).toBeGreaterThan(100);
  expect(result.recoveredChangedChannels).toBe(0);
  expect(result.windChangedChannels).toBeGreaterThan(100);
  await writeFile(
    testInfo.outputPath('upland-render-evidence.json'),
    JSON.stringify(result, null, 2),
  );
  expect(errors).toEqual([]);
});
