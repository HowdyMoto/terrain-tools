import { expect, it } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import { editFoliageModels } from '../src/core/foliage';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { FoliageDrawClusters } from '../src/runtime/foliage-clusters';
import { windUniforms } from '../src/runtime/wind';

it('clusters distant tree draws while preserving IDs, transforms, fades, shadows and export', () => {
  const p = createProject(32, 256);
  p.heights.fill(0);
  p.foliage = [];
  const model = editFoliageModels(p.brushes[0], [])[0];
  Object.assign(model, {
    lods: [
      { model: 'pine-low', distance: 60, density: 1 },
      { model: 'pine-low', distance: 150, density: 1 },
    ],
    lodFadeDuration: 0.4,
    cullDistance: 600,
    wind: 1,
  });
  for (let z = -112; z <= 112; z += 16)
    for (let x = -112; x <= 112; x += 16)
      p.foliage.push({
        id: p.nextId++,
        brushId: p.brushes[0].id,
        modelId: model.id,
        x,
        z,
        scale: 1,
        rotation: x * 0.1,
      });
  const scene = new TerrainScene(p),
    camera = new THREE.PerspectiveCamera();
  scene.rebuildFoliage();
  camera.position.set(0, 3, 350);
  scene.update(0.1, [], camera);
  const meshes = scene.foliage.children as THREE.InstancedMesh[];
  const clusters = meshes.filter((mesh) => mesh.userData.clustered);
  expect(clusters.length).toBeGreaterThan(0);
  expect(clusters.every((mesh) => mesh.userData.lodLevel >= 2)).toBe(true);
  const originalDraws = meshes.filter(
    (mesh) => !mesh.userData.clustered && mesh.count,
  ).length;
  expect(scene.foliage.viewStats.batches).toBeLessThan(originalDraws / 2);
  const check = () => {
    const visible = meshes.filter((mesh) => mesh.visible && mesh.count);
    const ids = new Set<number>();
    for (const mesh of visible) {
      expect(mesh.castShadow).toBe(true);
      expect(mesh.customDepthMaterial).toBeDefined();
      mesh.userData.instanceIds.forEach((id: number, slot: number) => {
        ids.add(id);
        const plant = p.foliage.find((plant) => plant.id === id)!;
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(slot, matrix);
        expect(matrix.elements[12]).toBe(plant.x);
        expect(matrix.elements[14]).toBe(plant.z);
        expect(
          mesh.boundingSphere!.containsPoint(
            new THREE.Vector3(plant.x, matrix.elements[13], plant.z),
          ),
        ).toBe(true);
      });
    }
    expect(ids.size).toBe(p.foliage.length);
    expect(
      meshes
        .filter((mesh) => mesh.userData.clusteredSource)
        .every((mesh) => !mesh.visible),
    ).toBe(true);
  };
  check();
  const versions = clusters.map((mesh) => mesh.instanceMatrix.version);
  scene.update(1 / 30, [], camera);
  expect(clusters.map((mesh) => mesh.instanceMatrix.version)).toEqual(versions);
  for (const z of [0, 230, 10, 350]) {
    camera.position.z = z;
    for (let frame = 0; frame < 10; frame++) scene.update(0.1, [], camera);
    check();
  }
  p.heights.fill(5);
  scene.reanchorFoliage({ minX: -128, maxX: 128, minZ: -128, maxZ: 128 });
  for (const mesh of clusters.filter((mesh) => mesh.count))
    expect(mesh.instanceMatrix.array[13]).toBe(5);
  const exported = scene.foliage.forExport();
  const exportedIDs = new Set(
    exported.children.flatMap((mesh) => mesh.userData.instanceIds),
  );
  expect(exportedIDs.size).toBe(p.foliage.length);
  for (const mesh of exported.children as THREE.InstancedMesh[]) {
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material])
      material.dispose();
    mesh.dispose();
  }
  scene.dispose();
});

it.each([64, 128] as const)(
  'preserves full primary and intermediate draws through contact, reanchoring, rollback and rebuild in %i m cells',
  (cellSize) => {
    const p = createProject(16, 128);
    p.heights.fill(0);
    p.foliage = [];
    const model = editFoliageModels(p.brushes[0], [])[0];
    Object.assign(model, {
      model: 'pine',
      alignToNormal: true,
      lods: [{ model: 'pine-low', distance: 50, density: 0.7 }],
      lodFadeDuration: 0.25,
      cullDistance: 240,
      flexibility: { source: 'height', start: 0.3, end: 1, exponent: 2 },
      interaction: { enabled: true, radius: 5, recovery: 0.4 },
      crush: 1,
    });
    for (let z = -56; z <= 56; z += 8)
      for (let x = -56; x <= 56; x += 8)
        p.foliage.push({
          id: p.nextId++,
          brushId: p.brushes[0].id,
          modelId: model.id,
          x,
          z,
          scale: 1,
          rotation: (x - z) * 0.1,
        });
    const reference = new TerrainScene(p, { foliageClusters: false });
    const clustered = new TerrainScene(p, {
      foliageClusters: { nearby: true, nearbyCellSize: cellSize },
    });
    const camera = new THREE.PerspectiveCamera();
    const records = (scene: TerrainScene) => {
      const records: string[] = [];
      for (const mesh of scene.foliage.children as THREE.InstancedMesh[]) {
        if (!mesh.visible || !mesh.count) continue;
        const contact = mesh.geometry.getAttribute('terrainContact');
        const fade = mesh.geometry.getAttribute('terrainFade');
        mesh.userData.instanceIds.forEach((id: number, slot: number) => {
          records.push(
            JSON.stringify([
              id,
              mesh.userData.lodLevel,
              mesh.geometry.index!.count,
              Array.from(
                mesh.instanceMatrix.array.subarray(slot * 16, slot * 16 + 16),
              ),
              contact?.getX(slot),
              fade && [fade.getX(slot), fade.getY(slot), fade.getZ(slot)],
            ]),
          );
        });
      }
      return records.sort();
    };
    try {
      reference.rebuildFoliage();
      clustered.rebuildFoliage();
      const levels = new Set(
        (clustered.foliage.children as THREE.InstancedMesh[])
          .filter((mesh) => mesh.userData.clustered)
          .map((mesh) => mesh.userData.lodLevel),
      );
      expect(levels).toEqual(new Set([0, 1]));
      for (const z of [0, 80, 150, 500, -20]) {
        camera.position.set(0, 3, z);
        for (let i = 0; i < 12; i++) {
          const contacts =
            i < 4 ? [{ x: 8, z: 0, radius: 8, strength: 1 }] : [];
          reference.update(1 / 30, contacts, camera);
          clustered.update(1 / 30, contacts, camera);
          expect(records(clustered)).toEqual(records(reference));
        }
      }
      p.heights.fill(3);
      for (const scene of [reference, clustered])
        scene.reanchorFoliage({ minX: -64, maxX: 64, minZ: -64, maxZ: 64 });
      expect(records(clustered)).toEqual(records(reference));
      const before = records(clustered),
        next = structuredClone(p);
      next.foliage.splice(0, 50);
      const edit = clustered.foliage.beginEdit(next);
      edit.rollback();
      expect(records(clustered)).toEqual(before);
      for (const scene of [reference, clustered]) scene.foliage.rebuild(next);
      for (const scene of [reference, clustered]) scene.update(1, [], camera);
      expect(records(clustered)).toEqual(records(reference));
    } finally {
      reference.dispose();
      clustered.dispose();
    }
  },
);

it('does not rescan retained source buffers on settled wind-only frames', () => {
  const p = createProject(8, 128);
  p.heights.fill(0);
  p.foliage = [];
  const model = editFoliageModels(p.brushes[0], [])[0];
  model.wind = 1;
  for (let z = 4; z < 60; z += 8)
    for (let x = 4; x < 60; x += 8)
      p.foliage.push({
        id: p.nextId++,
        brushId: p.brushes[0].id,
        modelId: model.id,
        x,
        z,
        scale: 1,
        rotation: 0,
      });
  const scene = new TerrainScene(p, { foliageClusters: { nearby: true } }),
    camera = new THREE.PerspectiveCamera();
  try {
    scene.rebuildFoliage();
    scene.update(1 / 30, [], camera);
    const sources = (scene.foliage.children as THREE.InstancedMesh[]).filter(
      (mesh) => mesh.userData.clusteredSource,
    );
    expect(sources.length).toBeGreaterThan(0);
    let reads = 0;
    for (const mesh of sources) {
      let version = mesh.instanceMatrix.version;
      Object.defineProperty(mesh.instanceMatrix, 'version', {
        get() {
          reads++;
          return version;
        },
        set(value) {
          version = value;
        },
        configurable: true,
      });
    }
    for (let frame = 0; frame < 30; frame++) scene.update(1 / 30, [], camera);
    expect(reads).toBe(0);
    p.heights.fill(2);
    scene.reanchorFoliage({ minX: -64, maxX: 64, minZ: -64, maxZ: 64 });
    expect(reads).toBeGreaterThan(0);
    const exported = scene.foliage.forExport();
    for (const mesh of exported.children as THREE.InstancedMesh[]) {
      expect(mesh.userData.clusteredSource).toBeUndefined();
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        material.dispose();
      mesh.dispose();
    }
  } finally {
    scene.dispose();
  }
});

it.each(['opaque', 'blended', 'transmissive'])(
  'keeps %s material sorting safe when forming near clusters',
  (kind) => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshPhysicalMaterial({
      transparent: kind === 'blended',
      transmission: kind === 'transmissive' ? 1 : 0,
    });
    const parent = new THREE.Group(),
      resources = new Set<{ dispose(): void }>();
    const sources = [8, 40].map((x, id) => {
      const mesh = new THREE.InstancedMesh(geometry, material, 1);
      mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(x, 0, 0));
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(x, 0, 0), 2);
      mesh.userData = { lodLevel: 0, lodDistance: 0, instanceIds: [id] };
      parent.add(mesh);
      return { mesh, baseGeometry: geometry };
    });
    try {
      new FoliageDrawClusters(
        sources,
        parent,
        windUniforms(),
        (resource) => {
          resources.add(resource);
          return resource;
        },
        { nearby: true },
      );
      const clusters = parent.children.filter(
        (mesh) => mesh.userData.clustered,
      );
      expect(clusters).toHaveLength(kind === 'opaque' ? 1 : 0);
      expect(sources.every(({ mesh }) => mesh.visible)).toBe(kind !== 'opaque');
    } finally {
      for (const resource of resources) resource.dispose();
      for (const { mesh } of sources) mesh.dispose();
      geometry.dispose();
      material.dispose();
    }
  },
);
