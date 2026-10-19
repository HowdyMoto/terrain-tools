import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../src/core/terrain';
import * as water from '../src/core/water';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { prepareWaterTerrain } from '../src/runtime/water';

const region = { minX: -8, maxX: 8, minZ: -8, maxZ: 8 };
const scenes: TerrainScene[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  scenes.splice(0).forEach((scene) => scene.dispose());
});

function fixture(basin = false) {
  const p = createProject(32, 32);
  p.heights.fill(basin ? 5 : -2);
  p.foliage = [];
  p.props = [];
  p.water = water.defaultWaterSettings(p);
  p.water.seaLevel = 0;
  p.water.ocean.enabled = !basin;
  if (basin) {
    for (let z = 8; z <= 24; z++)
      for (let x = 8; x <= 24; x++) p.heights[z * 33 + x] = -2;
    p.water.bodies.push({
      id: 'pond',
      name: 'Pond',
      enabled: true,
      elevation: 0,
      extent: { kind: 'basin', x: 0, z: 0 },
      surface: water.waterPreset('pond'),
    });
  }
  const scene = new TerrainScene(p);
  scenes.push(scene);
  scene.waterSystem.apply(scene.waterSystem.prepare(p));
  scene.rebuildTerrain();
  return { p, scene };
}

describe('water during regional geometry previews', () => {
  it('updates touched height rows without flooding again, then resolves the complete water state before commit', () => {
    const { p, scene } = fixture();
    const original = scene.waterSystem.snapshotTerrain()!;
    const flood = vi.spyOn(water, 'waterMasks');
    const candidate = structuredClone(p);
    const edit = scene.beginEdit(candidate);
    const center = 16 * 33 + 16;
    for (const height of [-1, 2, 4]) {
      candidate.heights[center] = height;
      const prepared = scene.prepareTerrain(region, candidate, {
        waterPreview: true,
      });
      scene.applyTerrain(prepared);
      prepared.dispose();
      const preview = scene.waterSystem.snapshotTerrain()!;
      expect(preview.heights[center]).toBe(height);
      expect(preview.heights[0]).toBe(original.heights[0]);
      expect(preview.ocean).toEqual(original.ocean);
      expect(preview.shore).toEqual(original.shore);
    }
    expect(flood).not.toHaveBeenCalled();
    scene.finalizeWaterPreview();
    expect(flood).toHaveBeenCalledTimes(1);
    const final = prepareWaterTerrain(candidate)!;
    edit.commit();
    const committed = scene.waterSystem.snapshotTerrain()!;
    expect(committed.heights).toEqual(candidate.heights);
    expect(committed.ocean).toEqual(final.ocean);
    expect(committed.shore).toEqual(final.shore);
  });

  it('restores exact live water after failure even when recomputation remains unavailable, and supports a retry', () => {
    const { p, scene } = fixture();
    const original = scene.waterSystem.snapshotTerrain();
    const candidate = structuredClone(p);
    const edit = scene.beginEdit(candidate);
    candidate.heights[16 * 33 + 16] = 9;
    const prepared = scene.prepareTerrain(region, candidate, {
      waterPreview: true,
    });
    scene.applyTerrain(prepared);
    prepared.dispose();
    const fault = vi.spyOn(water, 'waterMasks').mockImplementation(() => {
      throw new RangeError('Injected water connectivity failure');
    });
    expect(() => scene.finalizeWaterPreview()).toThrow('connectivity failure');
    edit.rollback();
    expect(scene.project).toBe(p);
    expect(scene.waterSystem.snapshotTerrain()).toEqual(original);
    fault.mockRestore();
    const retry = scene.beginEdit(candidate);
    scene.rebuildTerrain(region);
    retry.commit();
    expect(scene.waterSystem.snapshotTerrain()!.heights[16 * 33 + 16]).toBe(9);
  });

  it('checks connectivity beyond the brush and rejects opening a basin to the terrain boundary', () => {
    const { p, scene } = fixture(true);
    const original = scene.waterSystem.snapshotTerrain();
    const candidate = structuredClone(p);
    const edit = scene.beginEdit(candidate);
    for (let x = 0; x <= 8; x++) candidate.heights[16 * 33 + x] = -2;
    const prepared = scene.prepareTerrain(
      { minX: -16, maxX: -8, minZ: -1, maxZ: 1 },
      candidate,
      { waterPreview: true },
    );
    scene.applyTerrain(prepared);
    prepared.dispose();
    expect(() => scene.finalizeWaterPreview()).toThrow(/spill/);
    edit.rollback();
    expect(scene.project).toBe(p);
    expect(scene.waterSystem.snapshotTerrain()).toEqual(original);
  });

  it('retains ordinary runtime rebuilding and requires a rollback-capable edit for deferred water', () => {
    const { p, scene } = fixture();
    expect(() =>
      scene.prepareTerrain(region, p, { waterPreview: true }),
    ).toThrow(/active geometry edit/);
    const flood = vi.spyOn(water, 'waterMasks');
    p.heights[16 * 33 + 16] = 6;
    scene.rebuildTerrain(region);
    expect(flood).toHaveBeenCalledTimes(1);
    expect(scene.waterSystem.snapshotTerrain()!.heights[16 * 33 + 16]).toBe(6);
  });

  it('updates an enclosed depression far beyond a brush when a channel connects it to the ocean', () => {
    const { p, scene } = fixture(true);
    p.water!.ocean.enabled = true;
    p.water!.bodies = [];
    scene.waterSystem.apply(scene.waterSystem.prepare(p));
    const center = 16 * 32 + 16;
    expect(scene.waterSystem.snapshotTerrain()!.ocean[center]).toBe(0);
    const candidate = structuredClone(p);
    const edit = scene.beginEdit(candidate);
    for (let x = 0; x <= 8; x++) candidate.heights[16 * 33 + x] = -2;
    const prepared = scene.prepareTerrain(
      { minX: -16, maxX: -8, minZ: -1, maxZ: 1 },
      candidate,
      { waterPreview: true },
    );
    scene.applyTerrain(prepared);
    prepared.dispose();
    expect(scene.waterSystem.snapshotTerrain()!.ocean[center]).toBe(0);
    scene.finalizeWaterPreview();
    edit.commit();
    const final = scene.waterSystem.snapshotTerrain()!;
    expect(final.ocean[center]).toBe(255);
    expect(final.shore[(16 * 33 + 16) * 4 + 2]).toBeGreaterThan(0);
  });
});
