import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createProject,
  effectiveHoles,
  generateTerrain,
  heightAt,
} from '../src/core/terrain';
import { fitPropCutout, propFootprint } from '../src/core/props';
import { parseProject, serializeProject } from '../src/core/serialization';
import type { PropInstance } from '../src/core/types';
import { ModelLibrary } from '../src/render/models';
import { propFromHandle } from '../src/render/prop-tools';
const prop = (changes: Partial<PropInstance> = {}): PropInstance => ({
  id: 1,
  model: 'platform',
  x: 0,
  z: 0,
  yOffset: 0,
  scale: 1,
  rotation: 0,
  cutHole: true,
  holeRadius: 4,
  ...changes,
});

describe('prop footprint authoring', () => {
  it('preserves circular cell masks and painted holes for legacy projects', () => {
    const p = createProject(32, 64);
    p.holes[0] = 1;
    p.props = [
      prop({ x: -7.2, z: 9.5, scale: 1.2, rotation: 2.3 }),
      prop({ id: 2, x: 30, z: -28, holeRadius: 7 }),
    ];
    const expected = p.holes.slice();
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++)
        if (
          p.props.some(
            (value) =>
              Math.hypot(
                (x + 0.5) * 2 - 32 - value.x,
                (z + 0.5) * 2 - 32 - value.z,
              ) <=
              value.holeRadius * value.scale,
          )
        )
          expected[z * 32 + x] = 1;
    expect(effectiveHoles(p)).toEqual(expected);
  });
  it('rotates and scales an off-centre rectangle in the same frame as a Three.js prop', () => {
    const p = prop({
      x: -5,
      z: 7,
      rotation: Math.PI / 2,
      scale: 2,
      cutout: {
        shape: 'rectangle',
        width: 8,
        depth: 2,
        offsetX: 3,
        offsetZ: -1,
      },
    });
    const footprint = propFootprint(p);
    expect(footprint.bounds.minX).toBeCloseTo(-9);
    expect(footprint.bounds.maxX).toBeCloseTo(-5);
    expect(footprint.bounds.minZ).toBeCloseTo(-7);
    expect(footprint.bounds.maxZ).toBeCloseTo(9);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(p.x, 0, p.z),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        p.rotation,
      ),
      new THREE.Vector3().setScalar(p.scale),
    );
    for (const [x, z, inside] of [
      [3, -1, true],
      [6.9, -0.1, true],
      [7.1, -1, false],
      [3, 0.1, false],
    ] as const) {
      const point = new THREE.Vector3(x, 0, z).applyMatrix4(matrix);
      expect(footprint.contains(point.x, point.z)).toBe(inside);
    }
    for (const point of footprint.outline(64))
      expect(footprint.contains(point.x, point.z)).toBe(true);
  });
  it('composes overlapping footprints and restores previous cells when a prop moves or is removed', () => {
    const p = createProject(32, 32);
    p.holes[0] = 1;
    p.props = [
      prop({
        cutout: {
          shape: 'rectangle',
          width: 8,
          depth: 2,
          offsetX: 0,
          offsetZ: 0,
        },
      }),
    ];
    expect(effectiveHoles(p).reduce((a, b) => a + b, 0)).toBe(17);
    p.props[0].rotation = Math.PI / 2;
    p.props[0].scale = 2;
    expect(effectiveHoles(p).reduce((a, b) => a + b, 0)).toBe(65);
    p.props.push(prop({ id: 2, holeRadius: 2 }));
    p.props[0].x = 12;
    const moved = effectiveHoles(p);
    expect(moved[16 * 32 + 16]).toBe(1);
    expect(moved[20 * 32 + 16]).toBe(0);
    p.props = [];
    expect(effectiveHoles(p)).toEqual(p.holes);
    expect(p.holes.reduce((a, b) => a + b, 0)).toBe(1);
  });
  it('round-trips footprints and rejects malformed dimensions before accepting a document', () => {
    const p = createProject(32, 64);
    p.props = [
      prop({
        cutout: {
          shape: 'rectangle',
          width: 7,
          depth: 5,
          offsetX: -3,
          offsetZ: 2,
        },
      }),
    ];
    p.nextId = 2;
    expect(parseProject(serializeProject(p))).toEqual(p);
    for (const cutout of [
      { shape: 'polygon' },
      { ...p.props[0].cutout, width: -1 },
      { ...p.props[0].cutout, depth: '5' },
      { ...p.props[0].cutout, offsetZ: 10001 },
      [],
    ]) {
      const value = JSON.parse(serializeProject(p));
      value.props[0].cutout = cutout;
      expect(() => parseProject(JSON.stringify(value))).toThrow(/cutout/);
    }
    expect(() => fitPropCutout({ minX: 1, maxX: 0, minZ: 0, maxZ: 1 })).toThrow(
      'bounds',
    );
  });
  it('fits imported node transforms and displaced model origins without baking prop scale twice', async () => {
    const geometry = new THREE.BoxGeometry(2, 4, 6),
      material = new THREE.MeshStandardMaterial();
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(10, 2, -3),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        Math.PI / 2,
      ),
      new THREE.Vector3(2, 1, 1),
    );
    const library = new ModelLibrary(async () => ({
      parts: [{ geometry, material, matrix }],
      dispose: () => {
        geometry.dispose();
        material.dispose();
      },
    }));
    await library.loadAssets({
      assets: { shifted: { name: 'shifted', data: 'fixture' } },
    });
    const bounds = library.bounds('shifted'),
      cutout = fitPropCutout({
        minX: bounds.min.x,
        maxX: bounds.max.x,
        minZ: bounds.min.z,
        maxZ: bounds.max.z,
      });
    expect(cutout.width).toBeCloseTo(6);
    expect(cutout.depth).toBeCloseTo(4);
    expect(cutout.offsetX).toBe(10);
    expect(cutout.offsetZ).toBe(-3);
    expect(
      fitPropCutout({ minX: 8, maxX: 12, minZ: 3, maxZ: 3 }, 2).depth,
    ).toBe(2);
    library.dispose();
  });
});

describe('prop transform constraints', () => {
  it('preserves terrain-relative height for horizontal movement and uses Y to edit elevation', () => {
    const p = createProject(32, 64);
    generateTerrain(p, 'flat');
    for (let z = 0; z <= 32; z++)
      for (let x = 0; x <= 32; x++)
        p.heights[z * 33 + x] = (x * 2 - 32) / 4 + (z * 2 - 32) / 8;
    const before = prop({ yOffset: 2 }),
      handle = new THREE.Object3D();
    handle.position.set(10, 2, 6);
    const horizontal = propFromHandle(p, before, 'translate', 'XZ', handle);
    expect(horizontal.x).toBe(10);
    expect(horizontal.z).toBe(6);
    expect(horizontal.yOffset).toBe(2);
    handle.position.y = 15;
    const vertical = propFromHandle(p, horizontal, 'translate', 'Y', handle);
    expect(heightAt(p, vertical.x, vertical.z) + vertical.yOffset).toBe(15);
    handle.position.set(100, 20000, -100);
    const bounded = propFromHandle(p, before, 'translate', 'XYZ', handle);
    expect([bounded.x, bounded.z, bounded.yOffset]).toEqual([32, -32, 10000]);
    expect(before.x).toBe(0);
  });
  it('uses full yaw rotations and uniform positive scale regardless of the grabbed scale axis', () => {
    const p = createProject(32, 64),
      before = prop(),
      handle = new THREE.Object3D();
    handle.rotation.y = 2.8;
    expect(
      propFromHandle(p, before, 'rotate', 'Y', handle).rotation,
    ).toBeCloseTo(2.8);
    handle.scale.set(1, 2.5, 1);
    expect(propFromHandle(p, before, 'scale', 'Y', handle).scale).toBe(2.5);
    handle.scale.set(-2, 1, 1);
    expect(propFromHandle(p, before, 'scale', 'X', handle).scale).toBe(0.01);
    handle.scale.z = NaN;
    expect(propFromHandle(p, before, 'scale', 'Z', handle)).toEqual(before);
  });
});
