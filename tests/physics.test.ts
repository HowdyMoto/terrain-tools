import { Raycaster, Vector3 } from 'three';
import { runErosion, defaultErosionSettings } from '../src/core/erosion';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TerrainPhysics } from '../src/physics/rapier';
import {
  effectiveHoles,
  createProject,
  generateTerrain,
  applyBrush,
  heightAt,
} from '../src/core/terrain';
import RAPIER from '@dimforge/rapier3d-compat';
describe('Rapier terrain adapter', () => {
  const physics = new TerrainPhysics();
  beforeAll(async () => physics.init());
  afterAll(() => physics.dispose());
  it('supports a body on solid terrain and lets one fall through a real cutout', () => {
    const p = createProject(16, 32);
    generateTerrain(p, 'flat');
    for (let z = 6; z <= 9; z++)
      for (let x = 6; x <= 9; x++) p.holes[z * 16 + x] = 1;
    physics.rebuild(p);
    const supported = physics.drop(10, 6, 0, 0.5),
      falling = physics.drop(0, 6, 0, 0.5);
    for (let i = 0; i < 180; i++) physics.step(1 / 60);
    expect(supported.translation().y).toBeCloseTo(0.5, 1);
    expect(physics.touchesTerrain(supported)).toBe(true);
    expect(physics.touchesTerrain(falling)).toBe(false);
    expect(falling.translation().y).toBeLessThan(-15);
    physics.remove(supported);
    physics.remove(falling);
  });
  it('keeps dropped spheres stationary on flat triangle interiors and chunk seams', () => {
    const p = createProject(64, 64);
    generateTerrain(p, 'flat');
    physics.rebuild(p);
    for (const [x, z, radius] of [
      [3.158588887, 16.375863377, 1.4],
      [0.05, 8.7, 1.4],
      [-4.3, 0.05, 1.4],
      [0.05, 0.05, 1.4],
      [10.2, -7.7, 0.25],
      [-15.3, -12.6, 3],
      [30, 16, 1.4],
    ]) {
      const body = physics.drop(x, 15, z, radius);
      for (let step = 0; step < 900; step++) physics.step(1 / 60);
      const position = body.translation(),
        velocity = body.linvel();
      expect(position.x).toBeCloseTo(x, 2);
      expect(position.z).toBeCloseTo(z, 2);
      expect(position.y).toBeCloseTo(radius, 2);
      expect(Math.hypot(velocity.x, velocity.y, velocity.z)).toBeLessThan(
        0.001,
      );
      expect(physics.touchesTerrain(body)).toBe(true);
      physics.remove(body);
    }
  });
  it('rebuilds the collision surface after sculpting and honors prop cutouts', () => {
    const p = createProject(16, 32);
    p.heights.fill(8);
    p.props.push({
      id: 1,
      model: 'portal',
      x: 0,
      z: 0,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 4,
    });
    physics.rebuild(p);
    physics.step(1 / 60);
    expect(
      physics.world.castRay(
        new RAPIER.Ray({ x: 10, y: 30, z: 0 }, { x: 0, y: -1, z: 0 }),
        100,
        true,
      )?.timeOfImpact,
    ).toBeCloseTo(22);
    expect(
      physics.world.castRay(
        new RAPIER.Ray({ x: 0, y: 30, z: 0 }, { x: 0, y: -1, z: 0 }),
        100,
        true,
      ),
    ).toBeNull();
  });
  it('supports a body on a placed prop spanning a terrain cutout', () => {
    const p = createProject(16, 32);
    generateTerrain(p, 'flat');
    p.props = [
      {
        id: 1,
        model: 'platform',
        x: 0,
        z: 0,
        yOffset: 0,
        scale: 1,
        rotation: 0,
        cutHole: true,
        holeRadius: 5,
      },
    ];
    const scene = new TerrainScene(p);
    scene.rebuildProps();
    physics.rebuild(p);
    physics.setPropMeshes(scene.collisionMeshes(true, false));
    const body = physics.drop(0, 6, 0, 0.5);
    for (let i = 0; i < 180; i++) physics.step(1 / 60);
    expect(body.translation().y).toBeCloseTo(1.3, 1);
    expect(physics.touchesTerrain(body)).toBe(false);
    physics.remove(body);
    physics.setPropMeshes([]);
    scene.dispose();
  });
  it('keeps rotated stamp corners in both the rendered surface and collision', () => {
    const p = createProject(64, 64);
    generateTerrain(p, 'flat');
    physics.rebuild(p);
    applyBrush(p, {
      tool: 'stamp',
      x: -3,
      z: -3,
      radius: 6,
      strength: 1,
      falloff: 0.05,
      target: 9,
      material: 0,
      brushId: 'pine',
      seed: 42,
      rotation: Math.PI / 4,
      alpha: { width: 1, height: 1, values: new Float32Array([1]) },
    });
    const bound = 6 * Math.sqrt(2);
    physics.rebuild(p, {
      minX: -3 - bound,
      maxX: -3 + bound,
      minZ: -3 - bound,
      maxZ: -3 + bound,
    });
    physics.step(1 / 60);
    const expected = heightAt(p, 4.1, -3.1);
    expect(expected).toBeGreaterThan(0);
    const hit = physics.world.castRay(
      new RAPIER.Ray({ x: 4.1, y: 30, z: -3.1 }, { x: 0, y: -1, z: 0 }),
      100,
      true,
    );
    expect(30 - hit!.timeOfImpact).toBeCloseTo(expected, 4);
  });
  it('matches eroded rendering and refreshed collision while keeping cutouts empty', () => {
    const p = createProject(32, 64);
    p.props.push({
      id: 1,
      model: 'platform',
      x: 0,
      z: 0,
      yOffset: 2,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 3,
    });
    p.holes[8 * 32 + 8] = 1;
    const before = p.heights.slice();
    p.heights = runErosion(
      { ...p, holes: effectiveHoles(p) },
      {
        ...defaultErosionSettings(),
        rainfall: 6,
        talus: 20,
      },
    ).heights;
    let index = 0;
    for (let i = 0; i < before.length; i++)
      if (
        Math.abs(p.heights[i] - before[i]) >
        Math.abs(p.heights[index] - before[index])
      )
        index = i;
    expect(Math.abs(p.heights[index] - before[index])).toBeGreaterThan(0.1);
    const x = (index % 33) * 2 - 32,
      z = Math.floor(index / 33) * 2 - 32;
    const scene = new TerrainScene(p);
    scene.rebuildTerrain();
    scene.rebuildProps();
    const terrainRay = new Raycaster(
      new Vector3(x + 0.1, 100, z + 0.1),
      new Vector3(0, -1, 0),
    );
    scene.updateMatrixWorld(true);
    const hit = terrainRay.intersectObjects(scene.terrain.children, true)[0];
    physics.setPropMeshes([]);
    physics.rebuild(p);
    physics.step(1 / 60);
    const ray = new RAPIER.Ray(
      { x: x + 0.1, y: 100, z: z + 0.1 },
      { x: 0, y: -1, z: 0 },
    );
    const collision = physics.world.castRay(ray, 300, true);
    expect(hit.point.y).toBeCloseTo(heightAt(p, x + 0.1, z + 0.1), 4);
    expect(100 - collision!.timeOfImpact).toBeCloseTo(hit.point.y, 4);
    for (const [hx, hz] of [
      [0, 0],
      [-15, -15],
    ])
      expect(
        physics.world.castRay(
          new RAPIER.Ray({ x: hx, y: 100, z: hz }, { x: 0, y: -1, z: 0 }),
          300,
          true,
        ),
      ).toBeNull();
    expect(scene.props.children[0].position.y).toBeCloseTo(
      heightAt(p, 0, 0) + 2,
      5,
    );
    scene.dispose();
  });
  it('retains distant collider handles during a local sculpt update', () => {
    const p = createProject(64, 128);
    generateTerrain(p, 'flat');
    physics.rebuild(p);
    physics.step(1 / 60);
    const ray = new RAPIER.Ray({ x: 40, y: 30, z: 40 }, { x: 0, y: -1, z: 0 }),
      before = physics.world.castRay(ray, 100, true)?.collider.handle;
    p.heights[10 * 65 + 10] = 5;
    physics.rebuild(p, { minX: -46, maxX: -42, minZ: -46, maxZ: -42 });
    physics.step(1 / 60);
    expect(physics.world.castRay(ray, 100, true)?.collider.handle).toBe(before);
  });
});

it('matches rotated rectangular cutouts in Three.js and Rapier before and after prop movement', async () => {
  const p = createProject(32, 64);
  generateTerrain(p, 'flat');
  p.holes[0] = 1;
  p.props = [
    {
      id: 1,
      model: 'portal',
      x: -8,
      z: -4,
      yOffset: 0,
      scale: 1.5,
      rotation: 0.7,
      cutHole: true,
      holeRadius: 0,
      cutout: {
        shape: 'rectangle',
        width: 14,
        depth: 4,
        offsetX: 3,
        offsetZ: -1,
      },
    },
  ];
  const scene = new TerrainScene(p),
    physics = new TerrainPhysics();
  await physics.init();
  try {
    for (let revision = 0; revision < 2; revision++) {
      scene.rebuildTerrain();
      scene.updateMatrixWorld(true);
      physics.rebuild(p);
      physics.step(1 / 60);
      const holes = effectiveHoles(p);
      expect(holes.some((value) => value === 1)).toBe(true);
      for (let z = 0; z < 32; z++)
        for (let x = 0; x < 32; x++) {
          const px = (x + 0.5) * 2 - 32,
            pz = (z + 0.5) * 2 - 32;
          const rendered =
            new Raycaster(
              new Vector3(px, 20, pz),
              new Vector3(0, -1, 0),
            ).intersectObjects(scene.terrain.children, true).length > 0;
          const collides =
            physics.world.castRay(
              new RAPIER.Ray({ x: px, y: 20, z: pz }, { x: 0, y: -1, z: 0 }),
              100,
              true,
            ) !== null;
          expect(rendered, 'rendered cell ' + x + ',' + z).toBe(
            !holes[z * 32 + x],
          );
          expect(collides, 'collision cell ' + x + ',' + z).toBe(rendered);
        }
      Object.assign(p.props[0], { x: 14, z: 10, scale: 0.75, rotation: -1.2 });
    }
  } finally {
    scene.dispose();
    physics.dispose();
  }
});
