import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { terrainExportGeometry } from '../src/runtime/bake-material';

describe('terrain export geometry', () => {
  it('fills only bake geometry while retaining export holes, source buffers and shared atlas coordinates', () => {
    const project = createProject(8, 32);
    project.holes[0] = 1;
    const scene = new TerrainScene(project);
    scene.rebuildTerrain();
    const source = (scene.terrain.children[0] as THREE.Mesh).geometry;
    const before = source.getIndex()!.array.slice();
    const exported = terrainExportGeometry(source, 32, false);
    const filled = terrainExportGeometry(source, 32, false, { x: 8, z: 8 });
    expect(exported.getIndex()!.count).toBe(63 * 6);
    expect(filled.getIndex()!.count).toBe(64 * 6);
    expect(source.getIndex()!.array).toEqual(before);
    expect(source.getAttribute('uv')).toBeUndefined();
    const uv = exported.getAttribute('uv'),
      positions = source.getAttribute('position');
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeCloseTo(positions.getX(i) / 32 + 0.5, 6);
      expect(uv.getY(i)).toBeCloseTo(0.5 - positions.getZ(i) / 32, 6);
    }
    exported.dispose();
    filled.dispose();
    expect(source.getAttribute('position').count).toBe(81);
    scene.dispose();
  });
  it('exports true face normals and orthogonal right-handed tangent frames for flat terrain shading', () => {
    const project = createProject(8, 32);
    project.view.lowPoly = true;
    const scene = new TerrainScene(project);
    scene.rebuildTerrain();
    const source = (scene.terrain.children[0] as THREE.Mesh).geometry;
    const exported = terrainExportGeometry(source, 32, true);
    expect(exported.index).toBeNull();
    expect(exported.getAttribute('position').count).toBe(
      source.getIndex()!.count,
    );
    const p = exported.getAttribute('position'),
      n = exported.getAttribute('normal'),
      t = exported.getAttribute('tangent');
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3(),
      normal = new THREE.Vector3(),
      tangent = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i);
      b.fromBufferAttribute(p, i + 1);
      c.fromBufferAttribute(p, i + 2);
      const face = b.sub(a).cross(c.sub(a)).normalize();
      for (let vertex = i; vertex < i + 3; vertex++) {
        normal.fromBufferAttribute(n, vertex);
        tangent.fromBufferAttribute(t, vertex);
        expect(normal.distanceTo(face)).toBeLessThan(1e-6);
        expect(Math.abs(normal.dot(tangent))).toBeLessThan(1e-6);
        expect(tangent.length()).toBeCloseTo(1, 6);
        expect(t.getW(vertex)).toBe(1);
      }
    }
    exported.dispose();
    scene.dispose();
  });
});
