import { decodeDocument } from './fixtures.mjs';
import { test, expect } from '@playwright/test';
import { createProject } from 'terrain-tools';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { triangleGlb, solidPng } from './fixtures.mjs';
const image =
  'data:image/png;base64,' + solidPng(120, 170, 80).toString('base64');
const model = (height = 4, images = [image]) =>
  'data:model/gltf-binary;base64,' +
  triangleGlb({ height, images }).toString('base64');

async function packagePage(page) {
  // Exercise the built public package in a browser without production test hooks.
  const root = resolve('.');
  await page.route('**/__resource_test/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(
      '/__resource_test/'.length,
    );
    if (path === 'index.html')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Resource lifecycle test</title><script type="importmap">{"imports":{"three":"/__resource_test/three/build/three.module.js","three/webgpu":"/__resource_test/three/build/three.webgpu.js","three/tsl":"/__resource_test/three/build/three.tsl.js","three/":"/__resource_test/three/","three/addons/":"/__resource_test/three/examples/jsm/"}}</script>',
      });
    const local = path.startsWith('lib/')
      ? resolve(root, path)
      : path.startsWith('three/')
        ? resolve(root, 'node_modules', path)
        : '';
    if (!local.startsWith(root + sep)) return route.abort();
    await route.fulfill({
      contentType: 'text/javascript',
      body: await readFile(local),
    });
  });
  await page.goto('/__resource_test/index.html');
}
async function save(page, testInfo, name) {
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const file = testInfo.outputPath(name);
  await (await pending).saveAs(file);
  return decodeDocument(await readFile(file));
}
async function openProject(page, value) {
  await page.locator('#file-open').setInputFiles({
    name: 'resources.terrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}

test('built runtime owns decoded bitmaps, preserves host cache and releases late failed dependencies', async ({
  page,
}) => {
  await packagePage(page);
  const result = await page.evaluate(
    async ({ image, original, replacement, partial }) => {
      const THREE = await import('three');
      const { TerrainScene } = await import('/__resource_test/lib/runtime.js');
      const { createProject } = await import('/__resource_test/lib/core.js');
      const nativeBitmap = window.createImageBitmap.bind(window),
        records = [];
      const host = await nativeBitmap(await (await fetch(image)).blob());
      THREE.Cache.enabled = true;
      THREE.Cache.add('image-bitmap:' + image, host);
      const urls = [],
        revoked = new Set();
      const createURL = URL.createObjectURL.bind(URL),
        revokeURL = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = createURL(blob);
        urls.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        revoked.add(url);
        revokeURL(url);
      };
      let hold = false,
        release,
        started;
      window.createImageBitmap = async (...args) => {
        if (window.deferBadBitmap && args[0]?.size === 3)
          await window.deferBadBitmap;
        const bitmap = await nativeBitmap(...args),
          record = { bitmap, closes: 0 },
          close = bitmap.close.bind(bitmap);
        bitmap.close = () => {
          record.closes++;
          close();
        };
        records.push(record);
        if (hold) {
          const pending = new Promise((resolve) => {
            release = resolve;
          });
          started?.();
          await pending;
        }
        return bitmap;
      };
      const p = createProject(16, 32);
      p.view.textureResolution = 256;
      p.assets = {
        marker: { name: 'marker', data: original },
        alias: { name: 'alias', data: original },
      };
      const scene = new TerrainScene(p);
      await scene.load(p, false);
      const old = scene.library.get('marker');
      const candidate = structuredClone(p);
      candidate.assets.marker.data = replacement;
      candidate.assets.bad = {
        name: 'bad',
        data: 'data:model/gltf-binary;base64,YmFk',
      };
      let rejected = false;
      try {
        await scene.load(candidate, false);
      } catch {
        rejected = true;
      }
      const rollback =
        rejected &&
        scene.project === p &&
        scene.library.get('marker') === old &&
        records[0].closes === 0 &&
        records[1].closes === 1;
      const deduplicated =
        scene.library.get('marker') === scene.library.get('alias');
      hold = true;
      const waiting = new Promise((resolve) => {
        started = resolve;
      });
      const pending = scene.load(
        { ...p, assets: { late: { name: 'late', data: replacement } } },
        false,
      );
      await waiting;
      await scene.load({ ...p, assets: {} }, false);
      hold = false;
      release();
      const cancelled = (await pending) === false && records[2].closes === 1;
      // A bad second texture rejects the root while the first bitmap is still decoding.
      hold = true;
      const lateStarted = new Promise((resolve) => {
        started = resolve;
      });
      window.deferBadBitmap = lateStarted;
      const failure = scene.library
        .prepareAssets({
          assets: { partial: { name: 'partial', data: partial } },
        })
        .then(
          () => false,
          () => true,
        );
      await lateStarted;
      const partialFailed = await failure;
      hold = false;
      release();
      window.resourceCheck = { records, urls, revoked, THREE, host, scene };
      return {
        rollback,
        deduplicated,
        cancelled,
        partialFailed,
        hostWidth: host.width,
        oldClosed: records[0].closes,
      };
    },
    {
      image,
      original: model(4),
      replacement: model(8),
      partial: model(12, [image, 'data:image/png;base64,YmFk']),
    },
  );
  expect(result).toEqual({
    rollback: true,
    deduplicated: true,
    cancelled: true,
    partialFailed: true,
    hostWidth: 4,
    oldClosed: 1,
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.resourceCheck.records.map((record) => record.closes),
      ),
    )
    .toEqual([1, 1, 1, 1]);
  const cleanup = await page.evaluate(() => {
    const { records, urls, revoked, THREE, host, scene } = window.resourceCheck;
    scene.dispose();
    scene.dispose();
    const result = {
      closedOnce: records.every((record) => record.closes === 1),
      revoked: urls.every((url) => revoked.has(url)),
      cacheClean: urls.every(
        (url) =>
          THREE.Cache.get(url) === undefined &&
          THREE.Cache.get('image-bitmap:' + url) === undefined,
      ),
      hostWidth: host.width,
    };
    THREE.Cache.clear();
    THREE.Cache.enabled = false;
    host.close();
    return result;
  });
  expect(cleanup).toEqual({
    closedOnce: true,
    revoked: true,
    cacheClean: true,
    hostWidth: 4,
  });
});

test('surface candidates reuse live maps, clean failed allocations and honour cancellation', async ({
  page,
}) => {
  await packagePage(page);
  const result = await page.evaluate(async (image) => {
    const THREE = await import('three');
    const { TerrainScene } = await import('/__resource_test/lib/runtime.js');
    const { createProject } = await import('/__resource_test/lib/core.js');
    const p = createProject(16, 32);
    p.view.textureResolution = 256;
    const scene = new TerrainScene(p);
    await scene.load(p);
    const material = scene.terrainMaterial,
      borrowed = await material.prepare(p),
      original = borrowed.value.textures.value.arrays;
    const disposed = new Map(),
      nativeDispose = THREE.Texture.prototype.dispose;
    THREE.Texture.prototype.dispose = function () {
      if (this.isDataArrayTexture)
        disposed.set(this, (disposed.get(this) ?? 0) + 1);
      nativeDispose.call(this);
    };
    const bad = structuredClone(p);
    bad.materials[0].textures.orm = 'data:image/png;base64,YmFk';
    let failed = false;
    try {
      await material.prepare(bad);
    } catch {
      failed = true;
    }
    const failedArrays = disposed.size;
    const next = structuredClone(p);
    next.view.textureResolution = 512;
    const staged = await material.prepare(next);
    const stagedArrays = staged.value.textures.value.arrays;
    staged.dispose();
    const abandonedFreed = stagedArrays.every(
      (texture) => disposed.get(texture) === 1,
    );
    const controller = new AbortController(),
      imageDescriptor = Object.getOwnPropertyDescriptor(
        HTMLImageElement.prototype,
        'src',
      );
    let started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...imageDescriptor,
      set(value) {
        if (value === image) started();
        else imageDescriptor.set.call(this, value);
      },
    });
    const pendingProject = structuredClone(p);
    pendingProject.materials[0].textures.orm = image;
    const pending = material.update(pendingProject, controller.signal);
    await waiting;
    controller.abort();
    const cancelled = (await pending) === false;
    Object.defineProperty(HTMLImageElement.prototype, 'src', imageDescriptor);
    const live = await material.prepare(p);
    const currentUnchanged = live.value.textures.value.arrays === original;
    live.dispose();
    await material.update(next);
    const retained = original.every((texture) => !disposed.has(texture));
    borrowed.dispose();
    const released = original.every((texture) => disposed.get(texture) === 1);
    scene.dispose();
    THREE.Texture.prototype.dispose = nativeDispose;
    return {
      failed,
      failedArrays,
      abandonedFreed,
      cancelled,
      currentUnchanged,
      retained,
      released,
      once: [...disposed.values()].every((count) => count === 1),
    };
  }, image);
  expect(result).toEqual({
    failed: true,
    failedArrays: 2,
    abandonedFreed: true,
    cancelled: true,
    currentUnchanged: true,
    retained: true,
    released: true,
    once: true,
  });
});

test('editor cancels stale imports and preserves the document and history on preparation failure', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (...args) => {
      if (window.rejectModelDecode)
        throw new Error('Injected image decode failure');
      const bitmap = await decode(...args);
      if (window.holdModelDecode)
        await new Promise((resolve) => {
          window.releaseModelDecode = resolve;
        });
      return bitmap;
    };
  });
  await page.goto('/');
  await expect(page.locator('#foliage-count')).not.toHaveText('0', {
    timeout: 30000,
  });
  const baseline = await save(page, testInfo, 'initial.json');
  baseline.name = 'Asset preparation baseline';
  baseline.foliage = [];
  // This fixture replaces the model registry; use self-contained procedural brushes.
  baseline.brushes = createProject().brushes;
  baseline.view.textureResolution = 256;
  baseline.assets = { marker: { name: 'marker.glb', data: model(4) } };
  baseline.props = [
    {
      id: baseline.nextId++,
      model: 'marker',
      x: 0,
      z: 0,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: false,
      holeRadius: 3,
    },
  ];
  await openProject(page, baseline);
  await expect(page.locator('#project-name')).toHaveValue(baseline.name);
  const broken = structuredClone(baseline);
  broken.name = 'Must not replace the baseline';
  broken.assets.marker.data = model(8);
  broken.assets.bad = {
    name: 'bad.glb',
    data: 'data:model/gltf-binary;base64,YmFk',
  };
  await openProject(page, broken);
  await expect(page.locator('#toast')).toContainText('Could not open project');
  expect(await save(page, testInfo, 'after-failure.json')).toEqual(baseline);
  const redoBefore = await page.locator('#redo').isDisabled();
  const pending = structuredClone(baseline);
  pending.name = 'Cancelled candidate';
  pending.assets.marker.data = model(8);
  await page.evaluate(() => {
    window.holdModelDecode = true;
    window.releaseModelDecode = undefined;
  });
  await openProject(page, pending);
  await page.waitForFunction(() => !!window.releaseModelDecode);
  await expect(page.locator('#preparation-status')).toContainText(
    'Opening project',
  );
  await page.screenshot({ path: testInfo.outputPath('cancel-import.png') });
  await page.locator('#cancel-preparation').click();
  await expect(page.locator('#preparation-status')).toBeHidden();
  await page.evaluate(() => {
    window.holdModelDecode = false;
    window.releaseModelDecode();
  });
  expect(await save(page, testInfo, 'after-cancel.json')).toEqual(baseline);
  expect(await page.locator('#redo').isDisabled()).toBe(redoBefore);
  await page.evaluate(() => {
    window.holdModelDecode = true;
    window.releaseModelDecode = undefined;
  });
  await openProject(page, pending);
  await page.waitForFunction(() => !!window.releaseModelDecode);
  const winner = structuredClone(baseline);
  winner.name = 'Newest request';
  winner.assets = {};
  winner.props = [];
  await openProject(page, winner);
  await expect(page.locator('#project-name')).toHaveValue(winner.name);
  await page.evaluate(() => {
    window.holdModelDecode = false;
    window.releaseModelDecode();
  });
  expect(await save(page, testInfo, 'newest.json')).toEqual(winner);
  const historyBeforeCancel = await page.locator('#undo').getAttribute('title');
  await page.evaluate(() => {
    window.holdModelDecode = true;
    window.releaseModelDecode = undefined;
  });
  await page.locator('#undo').click();
  await page.waitForFunction(() => !!window.releaseModelDecode);
  await expect(page.locator('#preparation-status')).toContainText(
    'Restoring undo',
  );
  await page.locator('#cancel-preparation').click();
  await page.evaluate(() => {
    window.holdModelDecode = false;
    window.releaseModelDecode();
  });
  expect(await save(page, testInfo, 'cancelled-undo.json')).toEqual(winner);
  expect(await page.locator('#undo').getAttribute('title')).toBe(
    historyBeforeCancel,
  );
  await expect(page.locator('#redo')).toBeDisabled();
  await page.evaluate(() => {
    window.rejectModelDecode = true;
  });
  await page.locator('#undo').click();
  await expect(page.locator('#toast')).toContainText(
    'Could not restore history',
  );
  expect(await save(page, testInfo, 'failed-undo.json')).toEqual(winner);
  await expect(page.locator('#redo')).toBeDisabled();
  await page.evaluate(() => {
    window.rejectModelDecode = false;
  });
  await page.locator('#undo').click();
  await expect(page.locator('#project-name')).toHaveValue(baseline.name);
  expect(await save(page, testInfo, 'undo.json')).toEqual(baseline);
  await page.locator('#redo').click();
  await expect(page.locator('#project-name')).toHaveValue(winner.name);
  expect(await save(page, testInfo, 'redo.json')).toEqual(winner);
  expect(errors).toEqual([]);
});
