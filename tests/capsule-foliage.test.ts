import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import { editFoliageModels } from '../src/core/foliage';
import { FoliageInteraction } from '../src/core/interaction';
import { foliageContactPreset } from '../src/core/foliage-contact';
import { serializeProject, parseProject } from '../src/core/serialization';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { TerrainWalker } from '../src/render/first-person';
import { prepareFlexibility } from '../src/render/foliage-flexibility';
import { packAffine } from '../src/render/native-foliage';
import { FoliageMotionHistory } from '../src/render/foliage-motion';

const body = {
  x: 0,
  z: 0,
  radius: 0.35,
  strength: 1,
  capsule: { bottom: 0, top: 1.95 },
};

describe('walking capsule foliage interaction', () => {
  it('uses plant extents, skips vertically separated/rigid plants and owns recoverable capsule poses', () => {
    const interaction = new FoliageInteraction(1);
    interaction.setInstances(
      [0, 4, 4, 0].map((x, i) => ({
        id: i,
        brushId: 'a',
        x,
        z: 0,
        scale: 1,
        rotation: 0,
      })),
    );
    const settings = { enabled: true, radius: 100, strength: 1, recovery: 2 };
    const bounds = (id: number) => ({
      radius: id === 1 ? 4 : 0.2,
      minY: id === 3 ? 5 : 0,
      maxY: id === 3 ? 6 : 2,
    });
    interaction.update(
      1 / 60,
      [body],
      settings,
      (id) => (id === 0 ? { ...settings, enabled: false } : undefined),
      100,
      bounds,
      4,
    );
    expect([0, 1, 2, 3].map((id) => interaction.amount(id))).toEqual([
      0, 1, 0, 0,
    ]);
    const copy = interaction.fork([
      { id: 1, brushId: 'a', x: 4, z: 0, scale: 1, rotation: 0 },
    ]);
    body.capsule.top = 7;
    expect(copy.capsule(1)!.capsule!.top).toBe(1.95);
    body.capsule.top = 1.95;
    copy.update(2, [], settings);
    expect(copy.amount(1)).toBeCloseTo(Math.exp(-1));
    expect(interaction.amount(1)).toBe(1);
    const retreat = interaction.fork([
      { id: 1, brushId: 'a', x: 4, z: 0, scale: 1, rotation: 0 },
    ]);
    retreat.update(
      0.1,
      [{ ...body, x: -0.5 }],
      settings,
      undefined,
      100,
      bounds,
      4,
    );
    expect(retreat.capsule(1)!.x).toBe(0);
    expect(retreat.amount(1)).toBeCloseTo(Math.exp(-0.05));
    copy.update(30, [], settings);
    expect(copy.capsule(1)).toBeUndefined();
    expect(copy.amount(1)).toBe(0);
    expect(
      interaction.update(
        0,
        [{ ...body, capsule: { bottom: 2, top: 1 } }],
        settings,
      ).size,
    ).toBe(1); // Recovery only.
  });

  it('follows feet/eye height on slopes and packs affine poses without changing authored matrices', () => {
    const p = createProject(8, 32);
    p.heights.fill(5);
    const walker = new TerrainWalker(p, {
      position: new THREE.Vector3(2, 6.8, 3),
      yaw: 1,
    });
    const camera = new THREE.PerspectiveCamera();
    walker.enter(camera);
    expect(walker.contact(camera)).toMatchObject({
      x: 2,
      z: 3,
      radius: 0.35,
      capsule: { bottom: 5, top: 6.95 },
    });
    walker.setKey('KeyW', true);
    walker.setKey('ShiftLeft', true);
    walker.update(camera, 0.1);
    const swept = walker.contacts(camera);
    expect(swept.length).toBeGreaterThanOrEqual(6);
    expect(Math.hypot(swept[0].x - 2, swept[0].z - 3)).toBeLessThanOrEqual(
      0.201,
    );
    expect(swept.at(-1)!.x).toBeCloseTo(camera.position.x);
    expect(swept.at(-1)!.z).toBeCloseTo(camera.position.z);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(2, 5, 3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 1, 0.3)),
      new THREE.Vector3(2, 0.8, 2),
    );
    const before = matrix.toArray();
    const packed = new Float32Array(12);
    packAffine(before, 0, packed, 0);
    const restored = new THREE.Matrix4().set(
      ...([
        ...packed.slice(0, 4),
        ...packed.slice(4, 8),
        ...packed.slice(8, 12),
        0,
        0,
        0,
        1,
      ] as Parameters<THREE.Matrix4['set']>),
    );
    restored.elements.forEach((value, i) =>
      expect(value).toBeCloseTo(before[i]),
    );
    expect(matrix.toArray()).toEqual(before);
  });

  it('masks alpha-tested leaves, keeps opaque trunks rigid and persists artist presets', () => {
    const geometry = new THREE.PlaneGeometry(1, 2);
    geometry.translate(0, 1, 0);
    const leaf = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
    const wood = new THREE.MeshStandardMaterial();
    const bounds = new THREE.Box3(
      new THREE.Vector3(-1, 0, -1),
      new THREE.Vector3(1, 10, 1),
    );
    const settings = foliageContactPreset('woody').flexibility!;
    prepareFlexibility(geometry, settings, bounds, wood);
    expect(
      [...geometry.getAttribute('terrainFlexibility').array].every(
        (v) => v === 0,
      ),
    ).toBe(true);
    prepareFlexibility(geometry, settings, bounds, leaf);
    expect(geometry.getAttribute('terrainFlexibility').getX(0)).toBe(1); // Low leaves on a tall tree still respond.
    const p = createProject(8, 32);
    const model = editFoliageModels(p.brushes[0], [])[0];
    for (const profile of ['grass', 'plant', 'woody', 'rigid'] as const) {
      Object.assign(model, foliageContactPreset(profile));
      expect(parseProject(serializeProject(p))).toEqual(p);
    }
    expect(model.interaction!.enabled).toBe(false);
    geometry.dispose();
    leaf.dispose();
    wood.dispose();
  });

  it('packs capsule poses through LODs and clusters, recovers when culled and preserves the document', () => {
    const p = createProject(16, 256);
    p.heights.fill(0);
    p.wind.enabled = false;
    const model = editFoliageModels(p.brushes[0], [])[0];
    Object.assign(model, foliageContactPreset('grass'), {
      model: 'grass',
      lods: [{ model: 'grass', distance: 5, density: 1 }],
      cullDistance: 80,
    });
    p.foliage = [0, 33].map((x, i) => ({
      id: i + 1,
      brushId: p.brushes[0].id,
      modelId: model.id,
      x,
      z: 0,
      scale: 1,
      rotation: 0.8,
    }));
    const before = serializeProject(p);
    const scene = new TerrainScene(p, { foliageClusters: { nearby: true } });
    scene.rebuildFoliage();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 3, 15);
    camera.updateMatrixWorld();
    scene.update(1 / 60, [body], camera);
    const drawn = (scene.foliage.children as THREE.InstancedMesh[]).filter(
      (m) => m.visible && m.count,
    );
    expect(
      drawn.some((m) => m.geometry.getAttribute('terrainContact')?.getX(0) < 0),
    ).toBe(true);
    for (const mesh of drawn)
      if (mesh.geometry.getAttribute('terrainContact')?.getX(0) < 0) {
        expect(
          mesh.geometry.getAttribute('terrainContact').getW(0),
        ).toBeCloseTo(0.35);
        expect(
          mesh.geometry.getAttribute('terrainCapsule').getY(0),
        ).toBeCloseTo(1.95);
      }
    scene.update(40, [], camera);
    expect(serializeProject(p)).toBe(before);
    for (const mesh of scene.foliage.children as THREE.InstancedMesh[])
      if (mesh.count)
        expect(mesh.geometry.getAttribute('terrainContact')?.getX(0) ?? 0).toBe(
          0,
        );
    scene.dispose();
  });

  it('matches capsule history by authored ID through compaction and snapshots mutable inputs', () => {
    const h = new FoliageMotionHistory(2),
      epoch = {};
    const matrix = new Float32Array(32);
    new THREE.Matrix4().toArray(matrix);
    new THREE.Matrix4().toArray(matrix, 16);
    const shape = new Float32Array([1, 2, 0.35, 4, 6, 7, 8, 0.4, 1, 3]);
    h.prepare(
      { serial: 1, epoch },
      [10, 20],
      matrix,
      1,
      new Float32Array([-1, -0.5]),
      1,
      [0, 0, 0, 0, 0, 0],
      shape,
    );
    shape.fill(0);
    h.prepare(
      { serial: 2, epoch },
      [20, 30],
      matrix,
      2,
      new Float32Array([-0.2, -1]),
      2,
      [0, 0, 0, 0, 0, 0],
      shape,
    );
    expect([...h.shapes.slice(0, 5)]).toEqual([
      7,
      8,
      expect.closeTo(0.4),
      1,
      3,
    ]);
    expect(h.states[0]).toBeCloseTo(-0.5);
    expect(h.states[1]).toBe(1);
    expect(h.states[3]).toBe(0);
  });
});
