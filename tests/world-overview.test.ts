import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildTerrainOverview } from '../src/core/terrain-overview';
import { createProject, buildMeshData } from '../src/core/terrain';
import { TerrainWorldOverview } from '../src/runtime/world-overview';
import { WorldAssets } from '../src/runtime/world-assets';
import type { TerrainWorld } from '../src/core/world';

const manifest: TerrainWorld = {
  kind: 'terrain-world',
  version: 1,
  tileSize: 250,
  tiles: [
    { x: 0, z: 0, source: 'a' },
    { x: 1, z: 0, source: 'b' },
  ],
};
function project(n = 128) {
  const p = createProject(8, 250);
  p.resolution = n;
  p.heights = new Float32Array((n + 1) ** 2);
  p.paint = new Float32Array((n + 1) ** 2 * 4);
  p.holes = new Uint8Array(n * n);
  for (let z = 0; z <= n; z++)
    for (let x = 0; x <= n; x++) {
      const i = z * (n + 1) + x;
      p.heights[i] = Math.sin(x * 0.05) * 3 + Math.cos(z * 0.08) * 2;
      p.paint[i * 4 + 2] = 1;
    }
  return p;
}
const camera = new THREE.PerspectiveCamera();
camera.position.set(125, 400, 125);
camera.updateMatrixWorld();

describe('distant terrain overview', () => {
  it('compacts coarse geometry while preserving every detailed boundary vertex, winding and painted weights', () => {
    const p = project(),
      before = p.heights.slice(),
      data = buildTerrainOverview(p);
    expect(data.positions.length).toBeLessThan((p.heights.length * 3) / 10);
    const selected = new Set(data.indices);
    const positions = new Map<number, number>();
    for (const i of selected) {
      const x = Math.round(((data.positions[i * 3] + 125) * 128) / 250),
        z = Math.round(((data.positions[i * 3 + 2] + 125) * 128) / 250);
      positions.set(z * 129 + x, data.positions[i * 3 + 1]);
      expect([...data.weights.slice(i * 4, i * 4 + 4)]).toEqual([0, 0, 1, 0]);
      expect(Math.hypot(...data.normals.slice(i * 3, i * 3 + 3))).toBeCloseTo(
        1,
        6,
      );
    }
    for (let i = 0; i <= 128; i++)
      for (const index of [i, i * 129, i * 129 + 128, 128 * 129 + i])
        expect(positions.get(index)).toBe(p.heights[index]);
    let area = 0;
    for (let i = 0; i < data.indices.length; i += 3) {
      const [a, b, c] = data.indices.slice(i, i + 3),
        p3 = data.positions;
      const triangle =
        ((p3[b * 3 + 2] - p3[a * 3 + 2]) * (p3[c * 3] - p3[a * 3]) -
          (p3[b * 3] - p3[a * 3]) * (p3[c * 3 + 2] - p3[a * 3 + 2])) /
        2;
      expect(triangle).toBeGreaterThan(0);
      area += triangle;
    }
    expect(area).toBeCloseTo(250 ** 2);
    expect(p.heights).toEqual(before);
  });
  it('keeps authoritative hole topology and rejects malformed samples', () => {
    const p = project(32);
    p.holes[100] = 1;
    const overview = buildTerrainOverview(p),
      full = buildMeshData(p);
    expect(overview.positions).toEqual(full.positions);
    expect(overview.indices).toEqual(full.indices);
    expect(() => buildTerrainOverview(p, undefined, 1024)).toThrow('budget');
    expect(() => buildTerrainOverview(p, 3)).toThrow();
    p.heights[4] = NaN;
    expect(() => buildTerrainOverview(p)).toThrow('height');
  });
  it('hides only admitted detailed cells and restores them immediately on eviction without decoding models', async () => {
    const assets = new WorldAssets(),
      dispose = vi.spyOn(assets, 'dispose'),
      decode = vi.spyOn(assets, 'decode');
    const overview = new TerrainWorldOverview(manifest, {
      assets,
      materials: false,
      radius: 3000,
      load: async () => project(),
    });
    overview.position.x = 50;
    overview.update(camera, ['0,0']);
    await overview.whenIdle();
    expect(overview.stats.residentTiles).toBe(2);
    expect(overview.stats.visibleTiles).toBe(1);
    expect(overview.streaming.get('0,0')!.visible).toBe(false);
    const mesh = overview.streaming.get('0,0')!;
    expect(mesh.position.x).toBe(125);
    overview.update(camera, []);
    expect(overview.stats.visibleTiles).toBe(2);
    expect(mesh.visible).toBe(true);
    expect(overview.stats.cpuBytes).toBe(overview.stats.gpuBytes);
    expect(overview.stats.gpuBytes).toBeLessThan(128 * 1024);
    expect(decode).not.toHaveBeenCalled();
    overview.dispose();
    await overview.whenIdle();
    expect(overview.children).toHaveLength(0);
    expect(overview.stats.gpuBytes).toBe(0);
    expect(dispose).not.toHaveBeenCalled();
    assets.dispose();
  });
  it('supports failed loads and retry, and rejects oversized candidates without disturbing visible terrain', async () => {
    let fail = true;
    const overview = new TerrainWorldOverview(manifest, {
      materials: false,
      radius: 3000,
      maxConcurrentLoads: 1,
      gpuByteLimit: 60000,
      load: async (tile) => {
        if (tile.x === 1 && fail) throw new Error('retry me');
        return project();
      },
    });
    overview.update(camera);
    await overview.whenIdle();
    const first = overview.streaming.get('0,0');
    expect(first).toBeDefined();
    expect(overview.streaming.errors.size).toBe(1);
    fail = false;
    overview.streaming.retry();
    await overview.whenIdle();
    expect(overview.streaming.get('0,0')).toBe(first);
    expect(overview.stats.residentTiles).toBe(1); // Two candidates exceed the retained geometry cap.
    expect(overview.streaming.errors.get('1,0')?.message).toMatch(/budget/i);
    overview.dispose();
    await overview.whenIdle();
  });
  it('drains a source that ignores cancellation and does not admit it after disposal', async () => {
    let release!: (p: ReturnType<typeof project>) => void;
    const overview = new TerrainWorldOverview(manifest, {
      materials: false,
      radius: 3000,
      maxConcurrentLoads: 1,
      load: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    overview.update(camera);
    await Promise.resolve();
    overview.dispose();
    release(project());
    await overview.whenIdle();
    expect(overview.stats.residentTiles).toBe(0);
    expect(overview.children).toHaveLength(0);
    expect(() => overview.update(camera)).toThrow('disposed');
  });
});
