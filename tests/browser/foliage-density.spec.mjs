import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { foliageMotionScene } from '../../scripts/foliage-motion-scene.mjs';

test('density-sized native foliage survives fades, culling and partial GPU uploads', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await runtimePackagePage(page);
  const fixture = await page.evaluate(foliageMotionScene, {
    width: 640,
    height: 360,
  });
  const result = await page.evaluate(async () => {
    const s = window.foliageMotionScene;
    const model = s.project.brushes[0].models[0];
    model.lods[0].density = 0.25;
    s.terrain.rebuildFoliage();
    const meshes = s.terrain.foliage.children;
    const parts = s.terrain.library.get(model.lods[0].model).length;
    const capacity = meshes
      .filter((m) => m.userData.lodLevel === 1)
      .reduce((n, m) => n + m.instanceMatrix.count, 0);
    const eligible = new Set();
    for (const mesh of meshes.filter((m) => m.userData.lodLevel === 0)) {
      const fade = mesh.geometry.getAttribute('terrainFade');
      mesh.userData.instanceIds.forEach((id, slot) => {
        if (fade.getZ(slot) < 0.25) eligible.add(id);
      });
    }
    const expectedCapacity = eligible.size * parts;
    const draw = async (dt = 0.1) => {
      await new Promise(requestAnimationFrame);
      s.step(dt, false);
      await s.renderer.backend.device.queue.onSubmittedWorkDone();
    };
    const phases = [];
    for (const z of [7.5, 16, 80, 6, 16]) {
      s.camera.position.z = z;
      s.camera.lookAt(0, 0.7, -4);
      for (let i = 0; i < 7; i++) await draw();
      phases.push({ ...s.terrain.foliage.viewStats });
      for (const mesh of meshes) {
        if (mesh.count > mesh.instanceMatrix.count)
          throw new Error('Draw exceeds reservation.');
        if (mesh.userData.instanceIds.length !== mesh.count)
          throw new Error('Lost packed IDs.');
      }
    }
    const buffers = new Map();
    for (const mesh of meshes) {
      for (const [name, stride] of [
        ['terrainInstance0', 20],
        ['terrainPreviousInstance0', 18],
      ]) {
        const data = mesh.geometry.getAttribute(name)?.data;
        if (data)
          buffers.set(s.renderer.backend.get(data).buffer, { mesh, stride });
      }
    }
    const queue = s.renderer.backend.device.queue;
    const original = queue.writeBuffer;
    const uploads = [];
    queue.writeBuffer = function (buffer, offset, data, start, size) {
      const entry = buffers.get(buffer);
      if (entry)
        uploads.push({
          bytes: (size ?? data.length - (start ?? 0)) * data.BYTES_PER_ELEMENT,
          expected: entry.mesh.count * entry.stride * 4,
          reserved: entry.mesh.instanceMatrix.count * entry.stride * 4,
        });
      return original.call(this, buffer, offset, data, start, size);
    };
    try {
      // Repack while some batches use only part of their capacity.
      s.camera.position.z = 9;
      s.camera.lookAt(0, 0.7, -4);
      for (let i = 0; i < 5; i++) await draw();
    } finally {
      queue.writeBuffer = original;
    }
    // A normal simulation step keeps wind moving without reanchoring plants.
    // TerrainFoliage's dt=0 path explicitly refreshes placement matrices.
    for (let i = 0; i < 3; i++) await draw(1 / 30);
    let stationaryUploads = 0;
    queue.writeBuffer = function (buffer, ...args) {
      if (buffers.has(buffer)) stationaryUploads++;
      return original.call(this, buffer, ...args);
    };
    try {
      for (let i = 0; i < 3; i++) await draw(1 / 30);
    } finally {
      queue.writeBuffer = original;
    }
    const pixels = await s.pixels();
    let min = 255,
      max = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      min = Math.min(min, pixels[i]);
      max = Math.max(max, pixels[i]);
    }
    return {
      capacity,
      expectedCapacity,
      uploads,
      stationaryUploads,
      phases,
      imageRange: max - min,
      errors: s.errors,
    };
  });
  await page.screenshot({ path: info.outputPath('density-ferns.png') });
  const cleanupBytes = await page.evaluate(() =>
    window.foliageMotionScene.dispose(),
  );
  await writeFile(
    info.outputPath('foliage-density.json'),
    JSON.stringify({ fixture, ...result, cleanupBytes }, null, 2),
  );
  expect(errors).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.capacity).toBe(result.expectedCapacity);
  expect(result.phases[2].instances).toBe(0);
  expect(result.phases[3].instances).toBeGreaterThan(0);
  expect(result.uploads.length).toBeGreaterThan(0);
  expect(result.stationaryUploads).toBe(0);
  expect(
    result.uploads.every((upload) => upload.bytes === upload.expected),
  ).toBe(true);
  expect(result.uploads.some((upload) => upload.bytes < upload.reserved)).toBe(
    true,
  );
  expect(result.imageRange).toBeGreaterThan(30);
  expect(cleanupBytes).toBe(0);
});
