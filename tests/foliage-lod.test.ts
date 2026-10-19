import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createProject, generateTerrain } from '../src/core/terrain';
import { editFoliageModels } from '../src/core/foliage';
import {
  foliageDistanceLevel,
  foliageDensityRank,
} from '../src/core/foliage-lod';
import { serializeProject, parseProject } from '../src/core/serialization';
import {
  serializeFoliageBrush,
  importFoliageBrush,
} from '../src/core/foliage-preset';
import { TerrainScene } from '../src/runtime/terrain-scene';
function fixture() {
  const project = createProject(16, 128);
  generateTerrain(project, 'flat');
  project.heights.fill(0);
  const model = editFoliageModels(project.brushes[0], project.foliage)[0];
  Object.assign(model, {
    model: 'pine',
    crush: 1,
    wind: 1.2,
    alignToNormal: false,
    lods: [{ model: 'pine-low', distance: 20, density: 1 }],
    cullDistance: 60,
    lodHysteresis: 0.1,
  });
  return { project, model };
}
function instance(id: number, x: number, z = 0) {
  return {
    id,
    brushId: 'pine',
    modelId: 'primary',
    x,
    z,
    scale: 1,
    rotation: 0,
  };
}
function drawn(scene: TerrainScene) {
  const result = new Map<number, number>();
  for (const mesh of scene.foliage.children as THREE.InstancedMesh[])
    if (mesh.visible && mesh.count) {
      for (const id of mesh.userData.instanceIds) {
        if (result.has(id)) expect(result.get(id)).toBe(mesh.userData.lodLevel); // Parts share one level.
        result.set(id, mesh.userData.lodLevel);
      }
    }
  return result;
}
describe('foliage distance detail', () => {
  it('validates ordered distance/density ranges and every embedded LOD asset reference', () => {
    const { project, model } = fixture();
    expect(parseProject(serializeProject(project))).toEqual(project);
    for (const patch of [
      { lods: [{ model: 'missing', distance: 20, density: 1 }] },
      { lods: [{ model: 'pine-low', distance: 0, density: 1 }] },
      {
        lods: [
          { model: 'pine-low', distance: 20, density: 0.5 },
          { model: 'grass', distance: 20, density: 0.4 },
        ],
      },
      {
        lods: [
          { model: 'pine-low', distance: 20, density: 0.5 },
          { model: 'grass', distance: 30, density: 1 },
        ],
      },
      {
        lods: Array.from({ length: 4 }, (_, i) => ({
          model: 'pine-low',
          distance: i + 1,
          density: 1,
        })),
      },
      { cullDistance: 20 },
      { cullDistance: -1 },
      { lodHysteresis: 0.6 },
      { lodHysteresis: '0.1' },
    ]) {
      const next = structuredClone(project);
      Object.assign(next.brushes[0].models![0], patch);
      expect(() => parseProject(serializeProject(next))).toThrow();
    }
    delete model.lods;
    delete model.cullDistance;
    delete model.lodHysteresis;
    expect(parseProject(serializeProject(project))).toEqual(project);
  });
  it('embeds and remaps LOD-only assets in portable brushes', () => {
    const { project, model } = fixture();
    project.assets = {
      distant: {
        name: 'Far tree.glb',
        data: 'data:model/gltf-binary;base64,AAAA',
      },
    };
    model.lods![0].model = 'distant';
    const text = serializeFoliageBrush(project, 'pine');
    expect(Object.keys(JSON.parse(text).assets)).toEqual(['distant']);
    const target = createProject(16, 128);
    target.assets.distant = {
      name: 'Unrelated.glb',
      data: 'data:model/gltf-binary;base64,AQID',
    };
    const imported = importFoliageBrush(target, text),
      lod = imported.brushes.at(-1)!.models![0].lods![0];
    expect(lod.model).not.toBe('distant');
    expect(imported.assets[lod.model]).toEqual(project.assets.distant);
    expect(target.assets).not.toEqual(imported.assets);
    expect(parseProject(serializeProject(imported))).toEqual(imported);
  });
  it('uses hysteresis in both directions and handles far culling and camera teleports', () => {
    const { model } = fixture();
    expect(foliageDistanceLevel(model, 20)).toBe(1);
    expect(foliageDistanceLevel(model, 21, 0)).toBe(0);
    expect(foliageDistanceLevel(model, 23, 0)).toBe(1);
    expect(foliageDistanceLevel(model, 19, 1)).toBe(1);
    expect(foliageDistanceLevel(model, 17, 1)).toBe(0);
    expect(foliageDistanceLevel(model, 65, 1)).toBe(1);
    expect(foliageDistanceLevel(model, 67, 1)).toBe(2);
    expect(foliageDistanceLevel(model, 55, 2)).toBe(2);
    expect(foliageDistanceLevel(model, 53, 2)).toBe(1);
    expect(foliageDistanceLevel(model, 0, 2)).toBe(0);
    model.cullDistance = 0;
    expect(foliageDistanceLevel(model, 1e8)).toBe(1);
  });
  it('selects per instance in one spatial tile, packs complete parts and retains stable density subsets', () => {
    const { project, model } = fixture();
    project.foliage = [instance(1, 1), instance(2, 25), instance(3, 63)];
    const original = serializeProject(project),
      scene = new TerrainScene(project),
      camera = new THREE.PerspectiveCamera();
    scene.rebuildFoliage();
    scene.foliage.updateView(camera);
    expect([...drawn(scene)]).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(scene.foliage.viewStats).toMatchObject({
      instances: 2,
      culled: 1,
      levels: [1, 1, 0, 0],
    });
    for (const mesh of scene.foliage.children as THREE.InstancedMesh[]) {
      expect(mesh.customDepthMaterial!.customProgramCacheKey()).toMatch(
        /-1.2(?:\||$)/,
      );
      const matrix = new THREE.Matrix4();
      mesh.userData.instanceIds.forEach((id: number, slot: number) => {
        mesh.getMatrixAt(slot, matrix);
        expect(matrix.elements[12]).toBe(
          project.foliage.find((i) => i.id === id)!.x,
        );
      });
    }
    expect(serializeProject(project)).toBe(original);
    scene.dispose();
    project.foliage = Array.from({ length: 1000 }, (_, i) =>
      instance(i + 1, 25),
    );
    model.lods![0].density = 0.5;
    const a = new TerrainScene(project),
      b = new TerrainScene(project);
    a.rebuildFoliage();
    b.rebuildFoliage();
    a.foliage.updateView(camera);
    b.foliage.updateView(camera);
    const ids = [...drawn(a).keys()];
    expect(ids).toEqual([...drawn(b).keys()]);
    expect(ids.length).toBeGreaterThan(440);
    expect(ids.length).toBeLessThan(560);
    expect(ids.every((id) => foliageDensityRank(id) < 0.5)).toBe(true);
    camera.position.x = 25;
    a.foliage.updateView(camera);
    expect(drawn(a).size).toBe(1000);
    camera.position.x = 0;
    a.foliage.updateView(camera);
    expect([...drawn(a).keys()]).toEqual(ids);
    a.dispose();
    b.dispose();
  });
  it('keeps contact recovery and edited anchors correct while hidden or changing LOD', () => {
    const { project } = fixture();
    project.foliage = [instance(1, 0)];
    const scene = new TerrainScene(project),
      camera = new THREE.PerspectiveCamera();
    scene.rebuildFoliage();
    const full = (
      scene.foliage.children[0] as THREE.InstancedMesh
    ).instanceMatrix.array.slice();
    camera.position.z = 100;
    scene.update(1 / 60, [{ x: 0, z: 0, radius: 4, strength: 1 }], camera);
    expect(drawn(scene).size).toBe(0);
    project.heights.fill(8);
    scene.reanchorFoliage({ minX: -2, maxX: 2, minZ: -2, maxZ: 2 });
    scene.foliage.updateView(camera);
    camera.position.set(0, 8, 25);
    scene.foliage.updateView(camera);
    const low = scene.foliage.children.find(
      (mesh) => mesh.visible && mesh.userData.lodLevel === 1,
    ) as THREE.InstancedMesh;
    expect(low.instanceMatrix.array[13]).toBe(8);
    expect(low.instanceMatrix.array[5]).toBeLessThan(full[5]);
    for (let i = 0; i < 120; i++) scene.update(1, [], camera);
    camera.position.z = 0;
    scene.foliage.updateView(camera);
    const primary = scene.foliage.children.find(
      (mesh) => mesh.visible && mesh.userData.lodLevel === 0,
    ) as THREE.InstancedMesh;
    expect(primary.instanceMatrix.array[5]).toBeCloseTo(full[5], 5);
    expect(primary.instanceMatrix.array[13]).toBe(8);
    expect(
      primary.boundingSphere!.containsPoint(new THREE.Vector3(0, 8, 0)),
    ).toBe(true);
    scene.dispose();
  });
  it('uses terrain-local distances even when the terrain and camera have transformed parents', () => {
    const { project } = fixture();
    project.foliage = [instance(1, 0)];
    const scene = new TerrainScene(project),
      parent = new THREE.Group(),
      rig = new THREE.Group(),
      camera = new THREE.PerspectiveCamera();
    parent.position.set(100, 30, -50);
    parent.rotation.y = 0.7;
    parent.scale.setScalar(3);
    parent.add(scene);
    scene.rebuildFoliage();
    parent.updateMatrixWorld(true);
    const world = scene.localToWorld(new THREE.Vector3(0, 0, 25));
    rig.position.copy(world);
    rig.add(camera);
    scene.foliage.updateView(camera);
    expect(drawn(scene).get(1)).toBe(1);
    scene.dispose();
  });
  it('exports all primary instances when culled, without changing draw state or duplicating LOD geometry', () => {
    const { project } = fixture();
    project.foliage = [instance(1, 2), instance(2, 25)];
    const scene = new TerrainScene(project),
      camera = new THREE.PerspectiveCamera();
    scene.rebuildFoliage();
    camera.position.z = 1000;
    scene.foliage.updateView(camera);
    const exported = scene.foliage.forExport();
    expect(drawn(scene).size).toBe(0);
    expect(exported.children).toHaveLength(2); // Pine trunk + crown, one shared tile.
    for (const mesh of exported.children as THREE.InstancedMesh[]) {
      expect(mesh.count).toBe(2);
      expect(mesh.userData.instanceIds).toEqual([1, 2]);
      expect(mesh.userData.model).toBe('pine');
      expect(mesh.visible).toBe(true);
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        material.dispose();
      mesh.dispose();
    }
    expect(drawn(scene).size).toBe(0);
    const geometryDisposals = new Map<THREE.BufferGeometry, number>();
    for (const mesh of scene.foliage.children as THREE.InstancedMesh[])
      if (!geometryDisposals.has(mesh.geometry)) {
        geometryDisposals.set(mesh.geometry, 0);
        mesh.geometry.addEventListener('dispose', () =>
          geometryDisposals.set(
            mesh.geometry,
            geometryDisposals.get(mesh.geometry)! + 1,
          ),
        );
      }
    scene.dispose();
    expect([...geometryDisposals.values()].every((count) => count === 1)).toBe(
      true,
    );
  });
});

it('matches an uncached per-instance reference through slow motion, threshold crossings and teleports', () => {
  const { project, model } = fixture();
  model.lods = [
    { model: 'pine-low', distance: 20, density: 0.7 },
    { model: 'pine-low', distance: 40, density: 0.3 },
  ];
  model.cullDistance = 65;
  model.lodHysteresis = 0.15;
  project.foliage = Array.from({ length: 500 }, (_, i) =>
    instance(i + 1, Math.sin(i * 2.3) * 60, Math.cos(i * 1.7) * 60),
  );
  const scene = new TerrainScene(project),
    camera = new THREE.PerspectiveCamera();
  scene.rebuildFoliage();
  const levels = new Int8Array(project.foliage.length).fill(-1);
  for (let frame = 0; frame < 100; frame++) {
    camera.position.set(
      frame % 25 === 0 ? 150 : frame * 0.6 - 30,
      4,
      Math.sin(frame * 0.04) * 60,
    );
    const expected = new Map<number, number>();
    project.foliage.forEach((plant, i) => {
      const distance = Math.hypot(
        camera.position.x - plant.x,
        camera.position.y,
        camera.position.z - plant.z,
      );
      const level = foliageDistanceLevel(model, distance, levels[i]);
      levels[i] = level;
      const density = level === 0 ? 1 : (model.lods![level - 1]?.density ?? 0);
      if (foliageDensityRank(plant.id) < density) expected.set(plant.id, level);
    });
    scene.foliage.updateView(camera);
    expect(drawn(scene)).toEqual(expected);
    expect(scene.foliage.viewStats.instances).toBe(expected.size);
    expect(scene.foliage.viewStats.culled).toBe(
      project.foliage.length - expected.size,
    );
  }
  scene.dispose();
});
