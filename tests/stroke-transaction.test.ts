import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { createProject, generateTerrain } from '../src/core/terrain';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const p = createProject(64, 64);
  generateTerrain(p, 'flat');
  p.foliage = [
    { id: 1, brushId: 'grass', x: -10, z: -10, scale: 1, rotation: 0 },
  ];
  p.props = [
    {
      id: 2,
      model: 'platform',
      x: -10,
      z: -10,
      yOffset: 2,
      scale: 1,
      rotation: 0,
      cutHole: false,
      holeRadius: 3,
    },
  ];
  return p;
}
const region = { minX: -15, maxX: -5, minZ: -15, maxZ: -5 };
function watch(
  resource: THREE.BufferGeometry | THREE.Material | THREE.InstancedMesh,
) {
  const spy = vi.fn();
  if (resource instanceof THREE.InstancedMesh)
    resource.addEventListener('dispose', spy);
  else if (resource instanceof THREE.Material)
    resource.addEventListener('dispose', spy);
  else resource.addEventListener('dispose', spy);
  return spy;
}
it('restores exact terrain, foliage and prop resources after several previews without rebuilding', () => {
  const p = fixture(),
    scene = new TerrainScene(p);
  scene.rebuildTerrain();
  scene.rebuildFoliage();
  scene.rebuildProps();
  scene.update(0.1, [{ x: -10, z: -10, radius: 3, strength: 1 }]);
  const meshes = [...scene.terrain.children] as THREE.Mesh[],
    geometry = meshes.map((mesh) => mesh.geometry),
    previousFoliage = scene.foliage.children[0] as THREE.InstancedMesh,
    matrices = previousFoliage.instanceMatrix.array.slice(),
    prop = scene.props.children[0],
    releases = geometry.map(watch),
    foliageRelease = watch(previousFoliage);
  const candidate = structuredClone(p),
    edit = scene.beginEdit(candidate);
  const retired: ReturnType<typeof vi.fn>[] = [];
  for (const height of [4, 7]) {
    candidate.heights.fill(height);
    for (const mesh of scene.rebuildTerrain(region))
      retired.push(watch(mesh.geometry));
    scene.reanchorFoliage(region);
    scene.reanchorProps(region);
  }
  expect(scene.props.children[0].position.y).toBe(9);
  expect(scene.props.children[0]).not.toBe(prop);
  expect(scene.foliage.children[0]).not.toBe(previousFoliage);
  releases.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  expect(foliageRelease).not.toHaveBeenCalled();
  const failure = vi
    .spyOn(THREE.BufferGeometry.prototype, 'computeBoundingBox')
    .mockImplementation(() => {
      throw new RangeError('Persistent construction failure');
    });
  expect(() => scene.rebuildTerrain(region)).toThrow('Persistent construction');
  edit.rollback();
  edit.dispose();
  expect(scene.project).toBe(p);
  expect(scene.terrain.children).toEqual(meshes);
  meshes.forEach((mesh, i) => expect(mesh.geometry).toBe(geometry[i]));
  expect(scene.props.children[0]).toBe(prop);
  expect(prop.position.y).toBe(2);
  expect(scene.foliage.children[0]).toBe(previousFoliage);
  expect(previousFoliage.instanceMatrix.array).toEqual(matrices);
  retired.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  expect(failure).toHaveBeenCalledTimes(1);
  failure.mockRestore();
  scene.dispose();
  releases.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  expect(foliageRelease).toHaveBeenCalledTimes(1);
});
it('keeps completed edits and retires only replaced original terrain buffers', () => {
  const p = fixture(),
    scene = new TerrainScene(p);
  scene.rebuildTerrain();
  scene.rebuildFoliage();
  scene.rebuildProps();
  const meshes = [...scene.terrain.children] as THREE.Mesh[],
    geometry = meshes.map((mesh) => mesh.geometry),
    releases = geometry.map(watch),
    foliage = scene.foliage.children[0] as THREE.InstancedMesh,
    foliageRelease = watch(foliage);
  const candidate = structuredClone(p),
    edit = scene.beginEdit(candidate);
  candidate.heights.fill(3);
  const changed = scene.rebuildTerrain(region);
  scene.reanchorFoliage(region);
  scene.reanchorProps(region);
  edit.commit();
  edit.dispose();
  expect(scene.project).toBe(candidate);
  expect(scene.props.children[0].position.y).toBe(5);
  expect(foliageRelease).toHaveBeenCalledTimes(1);
  meshes.forEach((mesh, i) =>
    expect(releases[i]).toHaveBeenCalledTimes(changed.includes(mesh) ? 1 : 0),
  );
  expect(() => edit.commit()).toThrow('unavailable');
  scene.dispose();
  releases.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
});
it('rejects nested edits and project loading during a preview, and releases both states on disposal', async () => {
  const p = fixture(),
    scene = new TerrainScene(p);
  await scene.load(p, false);
  const original = scene.terrain.children[0] as THREE.Mesh,
    geometry = original.geometry,
    release = watch(geometry),
    candidate = structuredClone(p);
  const edit = scene.beginEdit(candidate);
  expect(() => scene.beginEdit(candidate)).toThrow('cannot start');
  await expect(scene.prepareLoad(candidate, false)).rejects.toThrow(
    'Finish the active',
  );
  scene.rebuildTerrain();
  const replacement = (scene.terrain.children[0] as THREE.Mesh).geometry,
    replacementRelease = watch(replacement);
  scene.dispose();
  edit.dispose();
  scene.dispose();
  expect(release).toHaveBeenCalledTimes(1);
  expect(replacementRelease).toHaveBeenCalledTimes(1);
  expect(scene.children).toHaveLength(0);
});
it('leaves the scene intact if preview allocation fails before the first dab', async () => {
  const p = fixture(),
    scene = new TerrainScene(p);
  await scene.load(p, false);
  const children = [...scene.foliage.children],
    props = [...scene.props.children],
    geometry = (scene.terrain.children[0] as THREE.Mesh).geometry,
    original = scene.library.get('grass')[0].geometry;
  const fault = vi.spyOn(original, 'clone').mockImplementation(() => {
    throw new RangeError('Cannot allocate preview');
  });
  expect(() => scene.beginEdit(structuredClone(p))).toThrow('Cannot allocate');
  expect(scene.project).toBe(p);
  expect(scene.foliage.children).toEqual(children);
  expect(scene.props.children).toEqual(props);
  expect((scene.terrain.children[0] as THREE.Mesh).geometry).toBe(geometry);
  fault.mockRestore();
  const retry = scene.beginEdit(structuredClone(p));
  retry.rollback();
  await scene.load(p, false);
  scene.dispose();
});

it('keeps retained foliage wind and contact recovery in step with the live simulation', () => {
  const p = fixture(),
    scene = new TerrainScene(p),
    reference = new TerrainScene(structuredClone(p));
  scene.rebuildFoliage();
  reference.rebuildFoliage();
  const contact = [{ x: -10, z: -10, radius: 3, strength: 1 }];
  scene.update(0.1, contact);
  reference.update(0.1, contact);
  const old = scene.foliage.children[0] as THREE.InstancedMesh;
  const candidate = structuredClone(p),
    edit = scene.beginEdit(candidate);
  candidate.heights.fill(5);
  scene.reanchorFoliage(region);
  for (let i = 0; i < 20; i++) {
    scene.update(0.1);
    reference.update(0.1);
  }
  edit.rollback();
  expect(scene.foliage.children[0]).toBe(old);
  expect(old.instanceMatrix.array).toEqual(
    (reference.foliage.children[0] as THREE.InstancedMesh).instanceMatrix.array,
  );
  const shader = {
    uniforms: {},
    vertexShader: '#include <begin_vertex>',
    fragmentShader: '',
  } as unknown as Parameters<THREE.Material['onBeforeCompile']>[0];
  (old.material as THREE.Material).onBeforeCompile(
    shader,
    undefined as unknown as THREE.WebGLRenderer,
  );
  expect(shader.uniforms.uTime.value).toBeCloseTo(2.1);
  scene.dispose();
  reference.dispose();
});
