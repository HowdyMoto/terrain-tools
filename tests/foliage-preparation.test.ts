import { expect, it, vi } from 'vitest';
import { createProject } from '../src/core/terrain';
import { editFoliageModels } from '../src/core/foliage';
import { TerrainScene } from '../src/runtime/terrain-scene';
import * as THREE from 'three';
import { foliagePendingInstanceBytes } from '../src/render/native-foliage';
import { yieldPreparation } from '../src/render/resources';

it('cancels cooperative foliage construction without changing the retained population, then retries', async () => {
  const project = createProject(16, 256);
  project.heights.fill(0);
  project.foliage = [];
  const model = editFoliageModels(project.brushes[0], [])[0];
  for (let i = 0; i < 100; i++)
    project.foliage.push({
      id: project.nextId++,
      brushId: project.brushes[0].id,
      modelId: model.id,
      x: (i % 10) * 24 - 108,
      z: Math.floor(i / 10) * 24 - 108,
      rotation: 0,
      scale: 1,
    });
  const scene = new TerrainScene(project);
  scene.rebuildFoliage();
  const children = [...scene.foliage.children];
  const ids = children.map((c) => [...c.userData.instanceIds]);
  const controller = new AbortController();
  let time = 0;
  const clock = vi
    .spyOn(performance, 'now')
    .mockImplementation(() => (time += 10));
  try {
    await expect(
      scene.foliage.prepareAsync(
        project,
        undefined,
        controller.signal,
        async (signal) => {
          controller.abort();
          signal.throwIfAborted();
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(scene.foliage.children).toEqual(children);
    expect(children.map((c) => c.userData.instanceIds)).toEqual(ids);
    let yields = 0;
    const prepared = await scene.foliage.prepareAsync(
      project,
      undefined,
      new AbortController().signal,
      async () => {
        yields++;
      },
    );
    expect(yields).toBeGreaterThan(10);
    scene.foliage.apply(prepared);
    expect(
      scene.foliage
        .forExport()
        .children.reduce((n, c) => n + c.userData.instanceIds.length, 0),
    ).toBeGreaterThanOrEqual(100);
  } finally {
    clock.mockRestore();
    scene.dispose();
  }
});

it('keeps distant source detail arrays unallocated, admits their growth conservatively and exports every primary plant', () => {
  const p = createProject(16, 256);
  p.heights.fill(0);
  p.foliage = [];
  const model = editFoliageModels(p.brushes[0], [])[0];
  Object.assign(model, {
    lods: [
      { model: 'pine-low', distance: 60, density: 1 },
      { model: 'pine-low', distance: 150, density: 1 },
    ],
    cullDistance: 600,
    lodFadeDuration: 0.3,
  });
  for (let i = 0; i < 100; i++)
    p.foliage.push({
      id: p.nextId++,
      brushId: p.brushes[0].id,
      modelId: model.id,
      x: (i % 10) * 24 - 108,
      z: Math.floor(i / 10) * 24 - 108,
      scale: 1,
      rotation: 0.2,
    });
  const scene = new TerrainScene(p, { foliageLazyInstances: true });
  scene.rebuildFoliage();
  const meshes = () => scene.foliage.children as THREE.InstancedMesh[];
  const reserved = () =>
    meshes().reduce(
      (sum, m) =>
        sum +
        m.instanceMatrix.array.byteLength +
        foliagePendingInstanceBytes(m) +
        (m.geometry.getAttribute('terrainFade')?.array.byteLength ?? 0) +
        (m.geometry.getAttribute('terrainContact')?.array.byteLength ?? 0),
      0,
    );
  const budget = reserved();
  expect(
    meshes()
      .filter((m) => !m.userData.clustered)
      .every((m) => m.instanceMatrix.count === 0),
  ).toBe(true);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 5, 350);
  camera.updateMatrixWorld();
  scene.update(0.1, [], camera);
  expect(scene.foliage.viewStats.instances).toBe(100);
  expect(
    meshes()
      .filter((m) => m.userData.lodLevel === 0)
      .every((m) => m.instanceMatrix.count === 0),
  ).toBe(true);
  expect(reserved()).toBe(budget);
  const exported = scene.foliage.forExport();
  expect(
    exported.children.reduce((n, m) => n + (m as THREE.InstancedMesh).count, 0),
  ).toBe(p.foliage.length * scene.library.get(model.model).length);
  const ids = new Set(exported.children.flatMap((m) => m.userData.instanceIds));
  expect([...ids].sort((a, b) => a - b)).toEqual(
    p.foliage.map((i) => i.id).sort((a, b) => a - b),
  );
  camera.position.set(0, 5, 0);
  camera.updateMatrixWorld();
  for (let i = 0; i < 12; i++) scene.update(1 / 30, [], camera);
  expect(
    meshes().some(
      (m) => m.userData.lodLevel === 0 && m.instanceMatrix.count > 0,
    ),
  ).toBe(true);
  expect(scene.foliage.viewStats.instances).toBe(100);
  expect(reserved()).toBe(budget);
  for (const object of exported.children) {
    const mesh = object as THREE.InstancedMesh;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material])
      m.dispose();
    mesh.dispose();
  }
  scene.dispose();
});

it('cancels a frame-aware preparation yield while RAF is suspended and releases its timer', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', () => 17);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  try {
    const c = new AbortController();
    const pending = yieldPreparation(c.signal);
    c.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledWith(17);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
