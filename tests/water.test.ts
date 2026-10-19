import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import { parseProject, serializeProject } from '../src/core/serialization';
import { resizeTerrain } from '../src/core/project-settings';
import {
  defaultWaterSettings,
  parseWaterSettings,
  waterContains,
  waterMasks,
  waterPreset,
} from '../src/core/water';
import { TerrainWater } from '../src/runtime/water';
import { prepareWaterShore } from '../src/runtime/water-shore';

function fixture() {
  const p = createProject(32, 64);
  p.heights.fill(-2);
  p.water = defaultWaterSettings(p);
  p.water.seaLevel = 1;
  p.water.bodies.push({
    id: 'pond',
    name: 'Forest pond',
    enabled: true,
    elevation: 4,
    extent: {
      kind: 'ellipse',
      x: 8,
      z: -6,
      radiusX: 7,
      radiusZ: 4,
      rotation: 30,
    },
    surface: waterPreset('pond'),
  });
  return { ...p, water: p.water };
}
describe('authored water', () => {
  it('round-trips independent levels, visibility, optics and outlines while retaining legacy documents', () => {
    const legacy = createProject(32, 64);
    legacy.view.water = false;
    legacy.view.waterLevel = 9;
    expect(parseProject(serializeProject(legacy)).water).toBeUndefined();
    const p = fixture();
    p.water.ocean.enabled = false;
    p.water.bodies.push({
      ...p.water.bodies[0],
      id: 'lake',
      elevation: 12,
      extent: {
        kind: 'polygon',
        points: [
          { x: -8, z: -8 },
          { x: 8, z: -8 },
          { x: 0, z: 8 },
        ],
      },
    });
    expect(parseProject(serializeProject(p)).water).toEqual(p.water);
    expect(p.water.bodies[0].enabled).toBe(true);
  });
  it('rejects malformed, unbounded and self-crossing authoring before preparing resources', () => {
    const w = fixture().water;
    expect(() => parseWaterSettings({ ...w, seaLevel: NaN })).toThrow();
    expect(() => parseWaterSettings({ ...w, schemaVersion: 2 })).toThrow(
      'version',
    );
    expect(() =>
      parseWaterSettings({ ...w, bodies: [w.bodies[0], w.bodies[0]] }),
    ).toThrow('unique');
    w.bodies[0].extent = {
      kind: 'polygon',
      points: [
        { x: -2, z: -2 },
        { x: 2, z: 2 },
        { x: -2, z: 2 },
        { x: 2, z: -2 },
      ],
    };
    expect(() => parseWaterSettings(w)).toThrow('cross');
    expect(() =>
      parseWaterSettings({ ...w, bodies: new Array(17).fill(w.bodies[0]) }),
    ).toThrow('16');
  });
  it('scales water shapes and optional levels while retaining optical distances and wave scales', () => {
    const p = fixture(),
      original = structuredClone(p.water);
    const resized = resizeTerrain(p, 128, true).water!;
    expect(resized.seaLevel).toBe(2);
    expect(resized.bodies[0].elevation).toBe(8);
    expect(resized.bodies[0].extent).toMatchObject({
      x: 16,
      z: -12,
      radiusX: 14,
      radiusZ: 8,
    });
    expect(resized.bodies[0].surface).toEqual(original.bodies[0].surface);
    expect(resizeTerrain(p, 128, false).water!.bodies[0].elevation).toBe(4);
    expect(p.water).toEqual(original);
  });
  it('floods only boundary-connected ocean and reports basin spill at an opened bank', () => {
    const p = fixture();
    p.heights.fill(-2);
    // Square bank encloses a disconnected submerged depression.
    for (let z = 10; z <= 22; z++)
      for (let x = 10; x <= 22; x++)
        if (x === 10 || x === 22 || z === 10 || z === 22)
          p.heights[z * 33 + x] = 5;
    p.water.bodies = [
      {
        ...p.water.bodies[0],
        elevation: 1,
        extent: { kind: 'basin', x: 0, z: 0 },
      },
    ];
    let masks = waterMasks(p, p.water);
    expect(masks.ocean[16 * 32 + 16]).toBe(0);
    expect(masks.ocean[0]).toBe(255);
    expect(masks.bodies[0].mask[16 * 32 + 16]).toBe(255);
    expect(masks.bodies[0].spills).toBe(false);
    p.water.bodies[0].elevation = 6;
    masks = waterMasks(p, p.water);
    expect(masks.bodies[0].spills).toBe(true);
  });
  it('tests rotated ellipses and concave polygons deterministically', () => {
    expect(
      waterContains(
        { kind: 'ellipse', x: 0, z: 0, radiusX: 8, radiusZ: 2, rotation: 90 },
        0,
        6,
      ),
    ).toBe(true);
    expect(
      waterContains(
        { kind: 'ellipse', x: 0, z: 0, radiusX: 8, radiusZ: 2, rotation: 90 },
        6,
        0,
      ),
    ).toBe(false);
    const extent = {
      kind: 'polygon' as const,
      points: [
        { x: 0, z: 0 },
        { x: 4, z: 0 },
        { x: 4, z: 1 },
        { x: 1, z: 1 },
        { x: 1, z: 4 },
        { x: 0, z: 4 },
      ],
    };
    expect(waterContains(extent, 0.5, 3)).toBe(true);
    expect(waterContains(extent, 3, 3)).toBe(false);
  });
  it('keeps committed meshes when a candidate is abandoned, and retries successfully', () => {
    const p = fixture(),
      water = new TerrainWater();
    const initial = water.prepare(p);
    water.apply(initial);
    const meshes = water.surfaces;
    const next = water.prepare({ ...p, water: { ...p.water, seaLevel: 8 } });
    next.dispose();
    expect(water.surfaces).toEqual(meshes);
    expect(() => water.apply(next)).toThrow('unavailable');
    const retry = water.prepare({ ...p, water: { ...p.water, seaLevel: 8 } });
    water.apply(retry);
    expect(water.surfaces[0].position.y).toBe(8);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(6000, 5, 4000);
    water.update(0.016, camera);
    expect(water.surfaces[0].position.x).toBe(6000);
    expect(water.surfaces[0].scale.x).toBeGreaterThan(camera.far);
    water.dispose();
  });
  it('reuses geometry for appearance edits and rejects a spilling basin before replacing live resources', () => {
    const p = fixture(),
      water = new TerrainWater();
    water.apply(water.prepare(p));
    const meshes = water.surfaces;
    const next = { ...p, water: parseWaterSettings(p.water) };
    next.water.ocean.surface.color = '#143d64';
    expect(water.canUpdateSettings(next)).toBe(true);
    water.updateSettings(next);
    expect(water.surfaces).toEqual(meshes);
    expect(
      (meshes[0].material as THREE.MeshStandardMaterial).color.getHexString(),
    ).toBe('143d64');
    const bad = { ...next, water: parseWaterSettings(next.water) };
    bad.water.bodies[0].extent = { kind: 'basin', x: 0, z: 0 };
    expect(() => water.prepare(bad)).toThrow('spill');
    expect(water.surfaces).toEqual(meshes);
    bad.water.bodies[0].enabled = false;
    water.apply(water.prepare(bad));
    const enabled = { ...bad, water: parseWaterSettings(bad.water) };
    enabled.water.bodies[0].enabled = true;
    expect(water.canUpdateSettings(enabled)).toBe(false);
    expect(() => water.prepare(enabled)).toThrow('spill');
    expect(water.surfaces[1].visible).toBe(false);
    water.dispose();
  });
  it('defaults old water to unchanged terrain shading and validates new optical controls', () => {
    const w = fixture().water;
    const old = JSON.parse(JSON.stringify(w));
    for (const s of [
      old.ocean.surface,
      ...old.bodies.map((b: { surface: object }) => b.surface),
    ]) {
      delete s.wetness;
      delete s.wetBand;
      delete s.caustics;
    }
    expect(parseWaterSettings(old).ocean.surface).toMatchObject({
      wetness: 0,
      wetBand: 0.6,
      caustics: 0,
    });
    w.ocean.surface.wetness = 2;
    expect(() => parseWaterSettings(w)).toThrow();
  });
  it('extends wet banks from connected water, retains isolated dry hollows, and fades shallow light with visibility', () => {
    const p = fixture();
    p.water.bodies = [];
    p.water.ocean.enabled = true;
    p.water.seaLevel = 0;
    p.water.ocean.surface.wetness = 1;
    p.water.ocean.surface.wetBand = 1;
    p.water.ocean.surface.caustics = 1;
    for (let z = 0; z <= 32; z++)
      for (let x = 0; x <= 32; x++) p.heights[z * 33 + x] = (x - 12) * 0.2;
    const shore = prepareWaterShore(p, waterMasks(p, p.water));
    const at = (x: number, z = 16) => (z * 33 + x) * 4;
    expect(shore[at(11)]).toBe(1);
    expect(shore[at(14)]).toBeGreaterThan(0.5);
    expect(shore[at(20)]).toBe(0);
    expect(shore[at(10) + 1]).toBeGreaterThan(0.8);
    p.water.ocean.surface.visibility = 0.05;
    const muddy = prepareWaterShore(p, waterMasks(p, p.water));
    expect(muddy[at(10) + 1]).toBeLessThan(0.01);
    p.heights.fill(-2);
    for (let z = 8; z <= 24; z++)
      for (let x = 8; x <= 24; x++)
        if (x === 8 || x === 24 || z === 8 || z === 24)
          p.heights[z * 33 + x] = 5;
    const isolated = prepareWaterShore(p, waterMasks(p, p.water));
    expect(isolated[at(16)]).toBe(0);
    p.water.ocean.enabled = false;
    expect(
      prepareWaterShore(p, waterMasks(p, p.water)).every((v) => v === 0),
    ).toBe(true);
  });
});
