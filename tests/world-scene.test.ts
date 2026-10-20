import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createProject, buildMeshData } from '../src/core/terrain';
import { buildTerrainLods } from '../src/core/terrain-lod';
import { TerrainWorldScene } from '../src/runtime/world-scene';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { TerrainLod } from '../src/runtime/terrain-lod';
import {
  TerrainPhysics,
  createWorldCollisionSource,
} from '../src/physics/rapier';
import type { TerrainWorld, WorldTile } from '../src/core/world';
const manifest: TerrainWorld = {
  kind: 'terrain-world',
  version: 1,
  tileSize: 32,
  tiles: [
    { x: 0, z: 0, source: 'a' },
    { x: 1, z: 0, source: 'b' },
  ],
};
function tile(descriptor: WorldTile, flat = false) {
  const p = createProject(32, 32);
  p.foliage = [];
  p.props = [];
  p.view.water = false;
  for (let z = 0; z <= 32; z++)
    for (let x = 0; x <= 32; x++)
      p.heights[z * 33 + x] = flat
        ? 0
        : Math.sin((x + descriptor.x * 32) * 0.1) * 2 + z * 0.03;
  return p;
}
function camera(x = 32) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
  camera.position.set(x, 10, 16);
  camera.updateMatrixWorld();
  return camera;
}

describe('terrain grid detail', () => {
  it('preserves all boundary positions through mixed topology and morph targets', () => {
    const p = tile(manifest.tiles[0]),
      data = buildMeshData(p),
      levels = buildTerrainLods(data.positions, data.indices, 32, 32);
    expect(levels.length).toBe(6);
    expect(levels.at(-1)!.indices.length).toBeLessThan(data.indices.length / 8);
    for (const level of levels) {
      const selected = new Set(level.indices);
      for (let i = 0; i <= 32; i++)
        for (const index of [i, i * 33, i * 33 + 32, 32 * 33 + i]) {
          expect(selected.has(index)).toBe(true);
          expect(level.target[index * 3 + 1]).toBe(
            data.positions[index * 3 + 1],
          );
        }
      for (let i = 0; i < level.indices.length; i += 3) {
        const [a, b, c] = level.indices.subarray(i, i + 3);
        const area =
          ((b % 33) - (a % 33)) * (Math.floor(c / 33) - Math.floor(a / 33)) -
          ((c % 33) - (a % 33)) * (Math.floor(b / 33) - Math.floor(a / 33));
        expect(area).toBeLessThan(0);
      }
    }
  });
  it('keeps hole topology at full detail', () => {
    const p = tile(manifest.tiles[0]);
    p.holes[16 * 32 + 16] = 1;
    const data = buildMeshData(p),
      levels = buildTerrainLods(data.positions, data.indices, 32, 32);
    expect(levels).toHaveLength(1);
    expect(levels[0].indices).toBe(data.indices);
  });
  it('settles after far and near teleports without moving edge vertices or authored heights', async () => {
    const p = tile(manifest.tiles[0]),
      heights = p.heights.slice(),
      terrain = new TerrainScene(p);
    await terrain.load(p, false);
    const lod = new TerrainLod(terrain),
      view = camera(10000);
    terrain.add(lod);
    const checkEdges = () => {
      for (const mesh of lod.children as THREE.Mesh[]) {
        const positions = mesh.geometry.getAttribute('position'),
          target = mesh.geometry.morphAttributes.position![0];
        expect(mesh.morphTargetInfluences![0]).toBeGreaterThanOrEqual(0);
        expect(mesh.morphTargetInfluences![0]).toBeLessThanOrEqual(1);
        for (let i = 0; i < positions.count; i++)
          if (
            Math.abs(positions.getX(i)) === 16 ||
            Math.abs(positions.getZ(i)) === 16
          )
            expect(target.getY(i)).toBe(positions.getY(i));
      }
    };
    for (let i = 0; i < 90; i++) {
      lod.update(view, 1080, 1 / 60);
      checkEdges();
    }
    expect(lod.stats.triangles).toBeLessThan(lod.stats.fullTriangles / 2);
    expect(lod.stats.transitioning).toBe(0);
    view.position.set(0, 2, 0);
    view.updateMatrixWorld();
    for (let i = 0; i < 90; i++) {
      lod.update(view, 1080, 1 / 60);
      checkEdges();
    }
    expect(lod.stats.triangles).toBe(lod.stats.fullTriangles);
    expect(lod.stats.transitioning).toBe(0);
    expect(p.heights).toEqual(heights);
    lod.dispose();
    expect(terrain.terrain.visible).toBe(true);
    terrain.dispose();
  });
});

describe('streamed rendered world', () => {
  it('loads neighboring terrain/foliage resources, matches normals, and releases cells after teleports', async () => {
    const world = new TerrainWorldScene(manifest, {
      radius: 48,
      maxResidentTiles: 2,
      materials: false,
      load: async (d) => tile(d),
    });
    const view = camera();
    world.update(view, 0);
    await world.whenIdle();
    expect(world.streaming.errors.size).toBe(0);
    expect(world.tiles).toHaveLength(2);
    expect(world.heightAt(32, 16)).toBeCloseTo(
      tile(manifest.tiles[1]).heights[16 * 33],
      5,
    );
    const left = world.tiles.find((t) => t.position.x === 16)!,
      right = world.tiles.find((t) => t.position.x === 48)!;
    const ln = (left.terrain.children[0] as THREE.Mesh).geometry.getAttribute(
        'normal',
      ),
      rn = (right.terrain.children[0] as THREE.Mesh).geometry.getAttribute(
        'normal',
      );
    for (const axis of ['getX', 'getY', 'getZ'] as const)
      expect(ln[axis](16 * 33 + 32)).toBeCloseTo(rn[axis](16 * 33), 6);
    world.update(camera(5000), 0);
    await world.whenIdle();
    expect(world.tiles).toHaveLength(0);
    expect(world.stats.residentTiles).toBe(0);
    expect(world.heightAt(32, 16)).toBeUndefined();
    world.update(view, 0);
    await world.whenIdle();
    expect(world.tiles).toHaveLength(2);
    world.dispose();
    await world.whenIdle();
    expect(world.stats.cpuBytes).toBe(0);
  });
  it('rejects mismatched edges without invalidating the adjacent terrain', async () => {
    const world = new TerrainWorldScene(manifest, {
      radius: 48,
      maxResidentTiles: 2,
      materials: false,
      load: async (d) => {
        const p = tile(d, true);
        if (d.x === 1) p.heights[16 * 33] = 3;
        return p;
      },
    });
    world.update(camera(16), 0);
    await world.whenIdle();
    expect(world.tiles).toHaveLength(1);
    expect(world.streaming.errors.get('1,0')?.message).toMatch(/edges/);
    expect(world.heightAt(16, 16)).toBe(0);
    world.dispose();
  });
  it('keeps full-resolution colliders across a shared edge and removes them on unload', async () => {
    const physics = new TerrainPhysics();
    await physics.init();
    const world = new TerrainWorldScene(manifest, {
      radius: 48,
      maxResidentTiles: 2,
      materials: false,
      load: async (d) => tile(d, true),
      collision: createWorldCollisionSource(physics.world),
    });
    world.update(camera(), 0);
    await world.whenIdle();
    const bodies = [31, 32, 33].map((x) => physics.drop(x, 5, 16, 0.5));
    for (let i = 0; i < 600; i++) physics.step(1 / 60);
    for (const body of bodies) expect(body.translation().y).toBeCloseTo(0.5, 1);
    expect(physics.world.colliders.len()).toBe(5);
    world.update(camera(5000), 0);
    await world.whenIdle();
    expect(physics.world.colliders.len()).toBe(3);
    world.dispose();
    await world.whenIdle();
    physics.dispose();
  });
});

it('stages optional GPU work before collision/admission and releases failure or cancelled work before retry', async () => {
  let fail = true,
    hold = false,
    release: (() => void) | undefined;
  const disposed: boolean[] = [],
    collisionPrepared: TerrainScene[] = [];
  const world = new TerrainWorldScene(manifest, {
    materials: false,
    radius: 48,
    maxResidentTiles: 2,
    load: async (d) => tile(d, true),
    prepareGPU: async (terrain) => {
      expect(terrain.parent).toBeNull();
      const index = disposed.push(false) - 1;
      (terrain.terrain.children[0] as THREE.Mesh).geometry.addEventListener(
        'dispose',
        () => {
          disposed[index] = true;
        },
      );
      if (terrain.position.x === 48 && fail) {
        fail = false;
        throw new Error('Injected shader warmup failure');
      }
      if (terrain.position.x === 16 && hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
    collision: {
      prepare: async (terrain) => {
        collisionPrepared.push(terrain);
        return { cpuBytes: 0, activate() {}, dispose() {} };
      },
    },
  });
  try {
    world.update(camera(), 0);
    await world.whenIdle();
    expect(world.tiles).toHaveLength(1);
    const retained = world.tiles[0];
    expect(world.streaming.errors.get('1,0')?.message).toContain('Injected');
    expect(disposed.filter(Boolean)).toHaveLength(1);
    expect(collisionPrepared).toHaveLength(1);
    world.streaming.retry('1,0');
    await world.whenIdle();
    expect(world.tiles).toHaveLength(2);
    expect(world.tiles).toContain(retained);
    expect(world.streaming.errors.size).toBe(0);
    world.update(camera(5000), 0);
    await world.whenIdle();
    hold = true;
    world.update(camera(), 0);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    world.update(camera(5000), 0);
    release!();
    await world.whenIdle();
    expect(world.tiles).toHaveLength(0);
    expect(world.stats.cpuBytes).toBe(0);
    hold = false;
    world.update(camera(), 0);
    await world.whenIdle();
    expect(world.tiles).toHaveLength(2);
    expect(world.streaming.errors.size).toBe(0);
  } finally {
    release?.();
    world.dispose();
    await world.whenIdle();
  }
  expect(disposed.every(Boolean)).toBe(true);
});
