import { expect, it } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import { editFoliageModels } from '../src/core/foliage';
import { TerrainScene } from '../src/runtime/terrain-scene';

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
