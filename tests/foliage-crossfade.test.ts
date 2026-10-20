import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FoliageLodTransitions } from '../src/core/foliage-lod';
import { createProject } from '../src/core/terrain';
import { editFoliageModels } from '../src/core/foliage';
import { serializeProject, parseProject } from '../src/core/serialization';
import {
  serializeProjectPackage,
  parseProjectPackage,
} from '../src/core/project-package';
import {
  serializeFoliageBrush,
  importFoliageBrush,
} from '../src/core/foliage-preset';
import { TerrainScene } from '../src/runtime/terrain-scene';

function fixture() {
  const project = createProject(32, 128);
  project.heights.fill(0);
  project.foliage = [];
  const model = editFoliageModels(project.brushes[0], project.foliage)[0];
  Object.assign(model, {
    model: 'pine',
    lods: [{ model: 'pine-low', distance: 10, density: 1 }],
    cullDistance: 40,
    lodHysteresis: 0,
    lodFadeDuration: 1,
    wind: 1,
    crush: 1,
    alignToNormal: false,
    flexibility: { source: 'height', start: 0, end: 1, exponent: 2 },
  });
  project.foliage = [
    {
      id: 1,
      brushId: project.brushes[0].id,
      modelId: model.id,
      x: 1,
      z: 1,
      scale: 1,
      rotation: 0,
    },
  ];
  project.nextId = 2;
  const scene = new TerrainScene(project);
  scene.rebuildFoliage();
  const camera = new THREE.PerspectiveCamera();
  const move = (distance: number) => {
    camera.position.set(1, 0, distance + 1);
    camera.updateMatrixWorld();
    scene.foliage.updateView(camera);
  };
  const meshes = () => scene.foliage.children as THREE.InstancedMesh[];
  const primary = () => meshes().find((mesh) => mesh.userData.lodLevel === 0)!;
  const distant = () => meshes().find((mesh) => mesh.userData.lodLevel === 1)!;
  const range = (mesh: THREE.InstancedMesh) => {
    const attr = mesh.geometry.getAttribute('terrainFade');
    return [attr.getX(0), attr.getY(0)];
  };
  return {
    project,
    model,
    scene,
    camera,
    move,
    meshes,
    primary,
    distant,
    range,
  };
}
const advance = (field: FoliageLodTransitions, time: number) =>
  field.advance(time, () => {});
describe('foliage cross-fades', () => {
  it('maintains complementary coverage through reversals, skipped levels, and hidden targets', () => {
    const field = new FoliageLodTransitions(1, 4, 1);
    field.setTarget(0, 1, 0);
    advance(field, 0.4);
    expect([...field.weights]).toEqual([
      expect.closeTo(0.6),
      expect.closeTo(0.4),
      0,
      0,
    ]);
    const before = field.weights.slice();
    field.setTarget(0, 3, 0.4);
    expect(field.weights).toEqual(before);
    advance(field, 0.7);
    expect(field.weights[0]).toBeCloseTo(0.42);
    expect(field.weights[1]).toBeCloseTo(0.28);
    expect(field.weights[3]).toBeCloseTo(0.3);
    const ranges = new Float32Array(8);
    for (let level = 0; level < 4; level++)
      field.writeRange(0, level, ranges, level * 2);
    expect(ranges[0]).toBe(0);
    expect(ranges[7]).toBe(1);
    for (let level = 1; level < 4; level++)
      expect(ranges[level * 2]).toBe(ranges[level * 2 - 1]);
    const reversed = field.weights.slice();
    field.setTarget(0, 0, 0.7);
    expect(field.weights).toEqual(reversed);
    advance(field, 1.7);
    expect([...field.weights]).toEqual([1, 0, 0, 0]);
    expect(field.activeCount).toBe(0);
    field.setTarget(0, -1, 2);
    advance(field, 2.5);
    expect([...field.weights]).toEqual([0.5, 0, 0, 0]);
    field.setTarget(0, 2, 2.5);
    advance(field, 3);
    expect([...field.weights]).toEqual([0.25, 0, 0.5, 0]);
    advance(field, 3.5);
    expect([...field.weights]).toEqual([0, 0, 1, 0]);
    expect(field.activeCount).toBe(0);
  });
  it('uses elapsed time consistently and initializes or disables transitions immediately', () => {
    for (const fps of [30, 60, 144]) {
      const field = new FoliageLodTransitions(2, 2, 1);
      field.setTarget(0, 1, 10);
      field.setTarget(1, -1, 10, true);
      for (let i = 1; i <= Math.floor(fps / 2); i++)
        advance(field, 10 + i / fps);
      expect(field.weights[0]).toBeCloseTo(0.5);
      expect(field.weights[1]).toBeCloseTo(0.5);
      let updates = 0;
      field.advance(10.5, () => updates++);
      expect(updates).toBe(0);
      advance(field, 11);
      expect([...field.weights]).toEqual([0, 1, 0, 0]);
      expect(field.activeCount).toBe(0);
      field.reset();
      expect([...field.weights]).toEqual([1, 0, 1, 0]);
    }
    const instant = new FoliageLodTransitions(1, 2, 0);
    instant.setTarget(0, 1, 0);
    expect([...instant.weights]).toEqual([0, 1]);
    expect(instant.activeCount).toBe(0);
    expect(() => new FoliageLodTransitions(1, 5, 1)).toThrow();
    expect(() => instant.setTarget(0, 4, 0)).toThrow();
  });
  it('preserves authored duration in project and brush formats and rejects invalid values', async () => {
    const { project, model, scene } = fixture();
    expect(parseProject(serializeProject(project))).toEqual(project);
    expect(
      parseProjectPackage(await serializeProjectPackage(project).arrayBuffer()),
    ).toEqual(project);
    const imported = importFoliageBrush(
      createProject(32, 128),
      serializeFoliageBrush(project, project.brushes[0].id),
    );
    expect(imported.brushes.at(-1)!.models![0].lodFadeDuration).toBe(1);
    for (const value of [-0.1, 5.1, NaN, '1', null]) {
      (model as unknown as { lodFadeDuration: unknown }).lodFadeDuration =
        value;
      expect(() => parseProject(serializeProject(project))).toThrow(
        /transition/,
      );
    }
    delete model.lodFadeDuration;
    expect(
      parseProject(serializeProject(project)).brushes[0].models![0]
        .lodFadeDuration,
    ).toBeUndefined();
    scene.dispose();
  });
  it('starts at the correct LOD and progresses with a stationary or omitted camera using only fade uploads', () => {
    const { scene, move, primary, distant, range } = fixture();
    move(20);
    expect(primary().count).toBe(0);
    expect(distant().count).toBe(1);
    expect(scene.foliage.viewStats.transitioning).toBe(0);
    const material = primary().material as THREE.Material;
    const key = material.customProgramCacheKey();
    const materialVersion = material.version;
    expect(key).toContain('lod-fade');
    move(0);
    expect(
      (primary().material as THREE.Material).customProgramCacheKey(),
    ).toContain('lod-fade');
    expect(primary().customDepthMaterial!.customProgramCacheKey()).toContain(
      'lod-fade',
    );
    expect(primary().customDistanceMaterial!.customProgramCacheKey()).toContain(
      'lod-fade',
    );
    expect(scene.foliage.viewStats).toMatchObject({
      instances: 1,
      drawnInstances: 2,
      transitioning: 1,
      levels: [1, 1, 0, 0],
    });
    const version = primary().instanceMatrix.version;
    scene.update(0.25);
    expect(range(primary())).toEqual([0, 0.25]);
    expect(range(distant())).toEqual([0.25, 1]);
    expect(primary().instanceMatrix.version).toBe(version);
    scene.update(0.75);
    expect(primary().count).toBe(1);
    expect(distant().count).toBe(0);
    expect(primary().material).toBe(material);
    expect(material.customProgramCacheKey()).toBe(key);
    expect(material.version).toBe(materialVersion);
    expect(primary().customDepthMaterial!.customProgramCacheKey()).toContain(
      'lod-fade',
    );
    expect(scene.foliage.viewStats).toMatchObject({
      instances: 1,
      drawnInstances: 1,
      transitioning: 0,
      levels: [1, 0, 0, 0],
    });
    scene.dispose();
  });
  it('keeps contact response synchronized in both LODs and recovers after fading out', () => {
    const { scene, move, primary, distant, range } = fixture();
    move(0);
    move(20);
    scene.update(0.4, [{ x: 1, z: 1, radius: 2, strength: 1 }]);
    const contact = primary().geometry.getAttribute('terrainContact').getX(0);
    expect(contact).toBeGreaterThan(0);
    expect(distant().geometry.getAttribute('terrainContact').getX(0)).toBe(
      contact,
    );
    const before = [range(primary()), range(distant())];
    move(0);
    expect([range(primary()), range(distant())]).toEqual(before);
    scene.update(1);
    move(100);
    scene.update(0.5);
    expect(range(primary())).toEqual([0, 0.5]);
    expect(scene.foliage.viewStats.instances).toBe(1);
    scene.update(0.5);
    expect(scene.foliage.viewStats).toMatchObject({
      instances: 0,
      drawnInstances: 0,
      culled: 1,
      transitioning: 0,
    });
    scene.update(20);
    move(0);
    scene.update(1);
    expect(
      primary().geometry.getAttribute('terrainContact').getX(0),
    ).toBeLessThan(contact);
    expect(range(primary())).toEqual([0, 1]);
    scene.dispose();
  });
  it('fades density changes and clears active transitions when resetting the view', () => {
    const { scene, model, project, move, primary, distant } = fixture();
    model.lods![0].density = 0;
    scene.rebuildFoliage();
    move(0);
    move(20);
    scene.update(0.5);
    expect(primary().count).toBe(1);
    expect(distant().count).toBe(0);
    expect(primary().geometry.getAttribute('terrainFade').getY(0)).toBeCloseTo(
      0.5,
    );
    scene.foliage.resetView();
    expect(scene.foliage.viewStats).toMatchObject({
      instances: 1,
      drawnInstances: 1,
      transitioning: 0,
    });
    scene.update(2);
    expect(primary().geometry.getAttribute('terrainFade').getY(0)).toBe(1);
    delete model.lodFadeDuration;
    scene.rebuildFoliage();
    move(20);
    expect(scene.foliage.viewStats.instances).toBe(0);
    expect(primary().geometry.hasAttribute('terrainFade')).toBe(false);
    expect(project.foliage).toHaveLength(1);
    scene.dispose();
  });
  it('exports every primary plant with static cloned materials during an active fade', () => {
    const { scene, move, primary, distant } = fixture();
    move(0);
    move(20);
    scene.update(0.5);
    const exported = scene.foliage.forExport();
    const materials = new Set<THREE.Material>(),
      geometries = new Set<THREE.BufferGeometry>();
    for (const mesh of exported.children as THREE.InstancedMesh[]) {
      expect(mesh.count).toBe(1);
      expect(mesh.geometry.hasAttribute('terrainFade')).toBe(false);
      expect(mesh.material).not.toBe(primary().material);
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]) {
        expect(material.onBeforeCompile).toBe(
          THREE.Material.prototype.onBeforeCompile,
        );
        materials.add(material);
      }
      geometries.add(mesh.geometry);
      mesh.dispose();
    }
    materials.forEach((material) => material.dispose());
    geometries.forEach((geometry) => geometry.dispose());
    expect(primary().count).toBe(1);
    expect(distant().count).toBe(1);
    scene.update(0.5);
    expect(primary().count).toBe(0);
    expect(distant().count).toBe(1);
    scene.dispose();
  });
});
