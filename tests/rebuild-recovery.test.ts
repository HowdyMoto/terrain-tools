import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { TerrainPhysics } from '../src/physics/rapier';
import { createProject, generateTerrain } from '../src/core/terrain';
import type { TerrainRegion } from '../src/core/types';

afterEach(() => vi.restoreAllMocks());
const region: TerrainRegion = { minX: -32, maxX: 1, minZ: -32, maxZ: -1 };
function fixture() {
  const p = createProject(64, 64);
  generateTerrain(p, 'flat');
  p.foliage = [
    { id: 1, brushId: 'grass', x: -4, z: -4, scale: 1, rotation: 0 },
    { id: 2, brushId: 'grass', x: 4, z: 4, scale: 1, rotation: 0 },
  ];
  p.props = [
    {
      id: 3,
      model: 'platform',
      x: 0,
      z: 0,
      yOffset: 1,
      scale: 1,
      rotation: 0,
      cutHole: false,
      holeRadius: 3,
    },
    {
      id: 4,
      model: 'boulder',
      x: 10,
      z: 10,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: false,
      holeRadius: 3,
    },
  ];
  p.nextId = 5;
  return p;
}
function geometries(scene: TerrainScene) {
  return (scene.terrain.children as THREE.Mesh[]).map((mesh) => mesh.geometry);
}
function failBoundsAfter(count: number) {
  const touched: THREE.BufferGeometry[] = [],
    freed = new Map<THREE.BufferGeometry, number>();
  const original = THREE.BufferGeometry.prototype.computeBoundingBox;
  const spy = vi
    .spyOn(THREE.BufferGeometry.prototype, 'computeBoundingBox')
    .mockImplementation(function (this: THREE.BufferGeometry) {
      touched.push(this);
      this.addEventListener('dispose', () =>
        freed.set(this, (freed.get(this) ?? 0) + 1),
      );
      if (touched.length === count)
        throw new RangeError('Injected geometry allocation failure');
      return original.call(this);
    });
  return { spy, touched, freed };
}
describe('rebuild failure recovery', () => {
  it.each([undefined, region])(
    'keeps every old terrain chunk if a later candidate fails (%j)',
    (area) => {
      const p = fixture(),
        scene = new TerrainScene(p);
      scene.rebuildTerrain();
      const meshes = [...scene.terrain.children],
        old = geometries(scene),
        oldRelease = old.map((geometry) => {
          const spy = vi.fn();
          geometry.addEventListener('dispose', spy);
          return spy;
        });
      p.heights.fill(7);
      const failure = failBoundsAfter(2);
      expect(() => scene.rebuildTerrain(area)).toThrow('Injected geometry');
      expect(scene.terrain.children).toEqual(meshes);
      expect(geometries(scene)).toEqual(old);
      oldRelease.forEach((spy) => expect(spy).not.toHaveBeenCalled());
      expect(failure.touched).toHaveLength(2);
      failure.touched.forEach((geometry) =>
        expect(failure.freed.get(geometry)).toBe(1),
      );
      failure.spy.mockRestore();
      const changed = scene.rebuildTerrain(area);
      expect(changed.length).toBeGreaterThan(1);
      for (const mesh of changed)
        expect(mesh.geometry.getAttribute('position').getY(0)).toBe(7);
      scene.dispose();
      oldRelease.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    },
  );
  it('rejects stale and foreign geometry preparations without losing current resources', () => {
    const p = fixture(),
      scene = new TerrainScene(p),
      other = new TerrainScene(p);
    scene.rebuildTerrain();
    const staged = scene.prepareTerrain(region);
    expect(() => other.applyTerrain(staged)).toThrow('owner');
    scene.rebuildTerrain(region);
    const current = geometries(scene);
    expect(() => scene.applyTerrain(staged)).toThrow('stale');
    expect(geometries(scene)).toEqual(current);
    const frees = staged.value.meshes.map((mesh) => {
      const fn = vi.fn();
      mesh.geometry.addEventListener('dispose', fn);
      return fn;
    });
    staged.dispose();
    staged.dispose();
    frees.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
    scene.dispose();
    other.dispose();
  });
  it('keeps foliage contacts and releases incomplete batches after a later geometry failure', () => {
    const p = fixture(),
      scene = new TerrainScene(p);
    p.foliage.push({
      id: 5,
      brushId: 'pine',
      x: 14,
      z: 14,
      scale: 1,
      rotation: 0,
    });
    scene.rebuildFoliage();
    scene.update(0.2, [{ x: -4, z: -4, radius: 3, strength: 1 }]);
    const meshes = [...scene.foliage.children] as THREE.InstancedMesh[],
      matrices = meshes.map((mesh) => mesh.instanceMatrix.array.slice()),
      source = scene.library.get('grass')[0].geometry,
      original = source.clone.bind(source),
      cloned: THREE.BufferGeometry[] = [],
      disposals: ReturnType<typeof vi.fn>[] = [];
    const materialsDisposed = vi.spyOn(THREE.Material.prototype, 'dispose'),
      meshesDisposed = vi.spyOn(THREE.InstancedMesh.prototype, 'dispose');
    const spy = vi.spyOn(source, 'clone').mockImplementation(() => {
      const geometry = original(),
        disposed = vi.fn();
      geometry.addEventListener('dispose', disposed);
      cloned.push(geometry);
      disposals.push(disposed);
      vi.spyOn(geometry, 'computeBoundingBox').mockImplementation(() => {
        throw new RangeError('Injected foliage geometry failure');
      });
      return geometry;
    });
    expect(() => scene.rebuildFoliage()).toThrow('Injected foliage');
    expect(scene.foliage.children).toEqual(meshes);
    meshes.forEach((mesh, i) =>
      expect(mesh.instanceMatrix.array).toEqual(matrices[i]),
    );
    expect(cloned).toHaveLength(1);
    disposals.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
    expect(materialsDisposed).toHaveBeenCalledTimes(7);
    expect(meshesDisposed).toHaveBeenCalledTimes(2);
    materialsDisposed.mockRestore();
    meshesDisposed.mockRestore();
    spy.mockRestore();
    scene.rebuildFoliage();
    (scene.foliage.children as THREE.InstancedMesh[]).forEach((mesh, i) =>
      expect(mesh.instanceMatrix.array).toEqual(matrices[i]),
    );
    scene.clearInteractions();
    const grassIndex = meshes.findIndex(
      (mesh) => mesh.userData.brushId === 'grass',
    );
    expect(
      (scene.foliage.children[grassIndex] as THREE.InstancedMesh).instanceMatrix
        .array,
    ).not.toEqual(matrices[grassIndex]);
    scene.dispose();
  });
  it('preserves all props if a later object fails and can retry', () => {
    const p = fixture(),
      scene = new TerrainScene(p);
    scene.rebuildProps();
    const before = [...scene.props.children],
      original = scene.library.object.bind(scene.library);
    let calls = 0;
    const spy = vi
      .spyOn(scene.library, 'object')
      .mockImplementation((...args) => {
        if (++calls === 2)
          throw new RangeError('Injected prop allocation failure');
        return original(...args);
      });
    p.props[0].x = 8;
    expect(() => scene.rebuildProps()).toThrow('Injected prop');
    expect(scene.props.children).toEqual(before);
    expect(scene.props.children[0].position.x).toBe(0);
    spy.mockRestore();
    scene.rebuildProps();
    expect(scene.props.children[0].position.x).toBe(8);
    scene.dispose();
  });
  it('prepares the entire project before applying and cleans up when prop preparation fails', async () => {
    const p = fixture(),
      scene = new TerrainScene(p);
    await scene.load(p, false);
    const oldMeshes = [...scene.terrain.children],
      oldFoliage = [...scene.foliage.children],
      oldProps = [...scene.props.children],
      candidate = structuredClone(p);
    candidate.name = 'replacement';
    candidate.heights.fill(12);
    const candidateGeometry: THREE.BufferGeometry[] = [],
      release: ReturnType<typeof vi.fn>[] = [];
    const original = scene.prepareTerrain.bind(scene);
    const capture = vi
      .spyOn(scene, 'prepareTerrain')
      .mockImplementation((...args) => {
        const staged = original(...args);
        for (const mesh of staged.value.meshes) {
          const fn = vi.fn();
          mesh.geometry.addEventListener('dispose', fn);
          candidateGeometry.push(mesh.geometry);
          release.push(fn);
        }
        return staged;
      });
    const broken = vi.spyOn(scene.library, 'object').mockImplementation(() => {
      throw new RangeError('Injected prop preparation failure');
    });
    await expect(scene.load(candidate, false)).rejects.toThrow('Injected prop');
    expect(scene.project).toBe(p);
    expect(scene.terrain.children).toEqual(oldMeshes);
    expect(scene.foliage.children).toEqual(oldFoliage);
    expect(scene.props.children).toEqual(oldProps);
    expect(candidateGeometry).toHaveLength(4);
    release.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
    broken.mockRestore();
    capture.mockRestore();
    const staged = await scene.prepareLoad(candidate, false);
    expect(scene.project).toBe(p);
    expect(
      staged.value.geometry.value.meshes[0].geometry
        .getAttribute('position')
        .getY(0),
    ).toBe(12);
    const fail = vi.spyOn(scene, 'rebuildTerrain').mockImplementation(() => {
      throw new Error('Commit must not rebuild');
    });
    scene.applyPrepared(staged);
    expect(scene.project).toBe(candidate);
    expect(fail).not.toHaveBeenCalled();
    expect(scene.props.children[0].position.y).toBe(13);
    staged.dispose();
    scene.dispose();
  });
});
function rayHeight(physics: TerrainPhysics, x = 10, z = -10) {
  const hit = physics.world.castRay(
    new RAPIER.Ray({ x, y: 40, z }, { x: 0, y: -1, z: 0 }),
    100,
    true,
  );
  return hit ? 40 - hit.timeOfImpact : null;
}
describe('collision replacement failure recovery', () => {
  it.each([undefined, region])(
    'retains all active terrain colliders after a failed allocation (%j)',
    async (area) => {
      const p = fixture(),
        physics = new TerrainPhysics();
      await physics.init();
      try {
        physics.rebuild(p);
        physics.step(1 / 60);
        const old = physics.world.colliders
          .getAll()
          .map((collider) => collider.handle)
          .sort();
        p.heights.fill(9);
        const create = physics.world.createCollider.bind(physics.world);
        let calls = 0;
        const spy = vi
          .spyOn(physics.world, 'createCollider')
          .mockImplementation((...args) => {
            if (++calls === 2)
              throw new RangeError('Injected collider allocation failure');
            return create(...args);
          });
        expect(() => physics.rebuild(p, area)).toThrow('Injected collider');
        expect(
          physics.world.colliders
            .getAll()
            .map((collider) => collider.handle)
            .sort(),
        ).toEqual(old);
        physics.step(1 / 60);
        expect(rayHeight(physics, -10, -10)).toBeCloseTo(0);
        spy.mockRestore();
        physics.rebuild(p, area);
        physics.step(1 / 60);
        expect(rayHeight(physics, -10, -10)).toBeCloseTo(9);
      } finally {
        physics.dispose();
      }
    },
  );
  it('keeps staged colliders disabled through real simulation steps and rejects stale candidates', async () => {
    const p = fixture(),
      physics = new TerrainPhysics();
    await physics.init();
    try {
      physics.rebuild(p);
      const candidate = structuredClone(p);
      candidate.heights.fill(10);
      const staged = physics.prepare(candidate);
      staged.value.created.forEach((collider) =>
        expect(collider.isEnabled()).toBe(false),
      );
      const body = physics.drop(10, 15, -10, 0.5);
      for (let i = 0; i < 240; i++) physics.step(1 / 60);
      expect(body.translation().y).toBeCloseTo(0.5, 1);
      expect(physics.touchesTerrain(body)).toBe(true);
      physics.remove(body);
      physics.apply(staged);
      staged.dispose();
      physics.step(1 / 60);
      expect(rayHeight(physics)).toBeCloseTo(10);
      const stale = physics.prepare(p);
      physics.rebuild(candidate);
      expect(() => physics.apply(stale)).toThrow('stale');
      stale.dispose();
      physics.step(1 / 60);
      expect(rayHeight(physics)).toBeCloseTo(10);
      const abandoned = physics.prepare(p);
      physics.dispose();
      expect(() => physics.apply(abandoned)).toThrow('disposed');
      abandoned.dispose();
    } finally {
      physics.dispose();
    }
  });
  it('rolls back terrain and prop candidates together when a later prop collider fails', async () => {
    const p = fixture(),
      scene = new TerrainScene(p),
      physics = new TerrainPhysics();
    await physics.init();
    scene.rebuildProps();
    try {
      physics.rebuild(p);
      const props = scene.collisionMeshes(true, false);
      physics.setPropMeshes(props);
      const old = physics.world.colliders
        .getAll()
        .map((collider) => collider.handle)
        .sort();
      const candidate = structuredClone(p);
      candidate.heights.fill(7);
      const create = physics.world.createCollider.bind(physics.world);
      let calls = 0;
      const spy = vi
        .spyOn(physics.world, 'createCollider')
        .mockImplementation((...args) => {
          if (++calls === 6)
            throw new RangeError('Injected second prop collider failure');
          return create(...args);
        });
      expect(() => physics.prepare(candidate, undefined, props)).toThrow(
        'Injected second prop',
      );
      expect(calls).toBe(6);
      expect(
        physics.world.colliders
          .getAll()
          .map((collider) => collider.handle)
          .sort(),
      ).toEqual(old);
      physics.step(1 / 60);
      expect(rayHeight(physics, 0, 0)).toBeCloseTo(1.8);
      expect(rayHeight(physics)).toBeCloseTo(0);
      spy.mockRestore();
      const staged = physics.prepare(candidate, undefined, []);
      physics.apply(staged);
      staged.dispose();
      physics.step(1 / 60);
      expect(rayHeight(physics, 0, 0)).toBeCloseTo(7);
    } finally {
      physics.dispose();
      scene.dispose();
    }
  });
});
