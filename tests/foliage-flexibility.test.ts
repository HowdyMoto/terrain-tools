import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import { editFoliageModels } from '../src/core/foliage';
import { serializeProject, parseProject } from '../src/core/serialization';
import {
  serializeProjectPackage,
  parseProjectPackage,
} from '../src/core/project-package';
import {
  serializeFoliageBrush,
  importFoliageBrush,
} from '../src/core/foliage-preset';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { decodeModel } from '../src/render/model-loader';
import {
  prepareFlexibility,
  hasFlexibilitySource,
  validateFlexibilityAttribute,
} from '../src/render/foliage-flexibility';

const ramp = { source: 'height' as const, start: 0, end: 1, exponent: 2 };
function fixture() {
  const project = createProject(32, 128);
  project.heights.fill(0);
  project.foliage = [];
  const model = editFoliageModels(project.brushes[0], project.foliage)[0];
  Object.assign(model, {
    model: 'pine',
    wind: 1.2,
    crush: 1,
    alignToNormal: false,
    flexibility: { ...ramp },
  });
  project.foliage = [1, 2, 3].map((id, i) => ({
    id,
    brushId: project.brushes[0].id,
    modelId: model.id,
    x: i * 20 + 1,
    z: 1,
    scale: 1,
    rotation: 0,
  }));
  project.nextId = 4;
  return { project, model };
}
function triangle() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 4, 0], 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}
function maskedGLB(values = [0, 128, 255], normalized = true, itemSize = 1) {
  const bin = new Uint8Array(48),
    view = new DataView(bin.buffer);
  new Float32Array(bin.buffer, 0, 9).set([0, 0, 0, 2, 0, 0, 0, 4, 0]);
  for (let i = 0; i < 3; i++) {
    if (normalized) bin[36 + i * 4] = values[i];
    else view.setFloat32(36 + i * 4, values[i], true);
  }
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [0, 3, 0], scale: [1, 2, 1] }],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0, _TERRAIN_FLEXIBILITY: 1 } }],
      },
    ],
    buffers: [{ byteLength: 48 }],
    bufferViews: [
      { buffer: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 12, byteStride: 4 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [2, 4, 0],
      },
      {
        bufferView: 1,
        componentType: normalized ? 5121 : 5126,
        normalized: normalized || undefined,
        count: 3,
        type: itemSize === 1 ? 'SCALAR' : 'VEC2',
      },
    ],
  });
  const text = new TextEncoder().encode(
    json.padEnd(Math.ceil(json.length / 4) * 4),
  );
  const bytes = new Uint8Array(28 + text.length + bin.length),
    header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, bytes.length, true);
  header.setUint32(12, text.length, true);
  header.setUint32(16, 0x4e4f534a, true);
  bytes.set(text, 20);
  header.setUint32(20 + text.length, bin.length, true);
  header.setUint32(24 + text.length, 0x004e4942, true);
  bytes.set(bin, 28 + text.length);
  return 'data:model/gltf-binary;base64,' + btoa(String.fromCharCode(...bytes));
}

describe('foliage flexibility masks', () => {
  it('preserves masks in JSON, native packages, and reusable brushes and rejects unusable ramps', async () => {
    const { project, model } = fixture();
    expect(parseProject(serializeProject(project))).toEqual(project);
    expect(
      parseProjectPackage(await serializeProjectPackage(project).arrayBuffer()),
    ).toEqual(project);
    const imported = importFoliageBrush(
      createProject(32, 128),
      serializeFoliageBrush(project, project.brushes[0].id),
    );
    expect(imported.brushes.at(-1)!.models![0].flexibility).toEqual(ramp);
    for (const invalid of [
      null,
      { ...ramp, source: 'uv' },
      { ...ramp, start: -1 },
      { ...ramp, start: 1 },
      { ...ramp, end: 0 },
      { ...ramp, end: 0.0001 },
      { ...ramp, exponent: 0.5 },
      { ...ramp, exponent: 9 },
    ]) {
      (model as unknown as { flexibility: unknown }).flexibility = invalid;
      expect(() => parseProject(serializeProject(project))).toThrow(
        /flexibility/,
      );
    }
    delete model.flexibility;
    expect(
      parseProject(serializeProject(project)).brushes[0].models![0].flexibility,
    ).toBeUndefined();
  });
  it('uses primary model-space height bounds and distinguishes missing RGB/alpha channels', () => {
    const geometry = triangle().translate(0, 3, 0);
    const bounds = new THREE.Box3(
      new THREE.Vector3(0, 3, 0),
      new THREE.Vector3(2, 11, 0),
    );
    prepareFlexibility(geometry, ramp, bounds);
    const mask = geometry.getAttribute('terrainFlexibility');
    expect(mask.getX(0)).toBe(0);
    expect(mask.getX(2)).toBeCloseTo(0.25);
    expect(mask.getZ(2)).toBeCloseTo(0.125); // d((height/8)^2)/dy at height 4.
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3),
    );
    expect(hasFlexibilitySource(geometry, 'red')).toBe(true);
    expect(hasFlexibilitySource(geometry, 'alpha')).toBe(false);
    prepareFlexibility(geometry, { ...ramp, source: 'alpha' }, bounds);
    expect([...geometry.getAttribute('terrainFlexibility').array]).toEqual(
      Array(12).fill(0),
    );
    geometry.dispose();
  });
  it('computes area-weighted gradients for painted masks and handles degenerate triangles', () => {
    const geometry = triangle();
    geometry.setAttribute(
      '_terrain_flexibility',
      new THREE.Float32BufferAttribute([0, 0.5, 1], 1),
    );
    geometry.setIndex([0, 1, 2, 0, 0, 1]);
    prepareFlexibility(
      geometry,
      { ...ramp, source: 'attribute', exponent: 1 },
      new THREE.Box3(),
    );
    const mask = geometry.getAttribute('terrainFlexibility');
    for (let i = 0; i < 3; i++) {
      expect(mask.getY(i)).toBeCloseTo(0.25);
      expect(mask.getZ(i)).toBeCloseTo(0.25);
      expect(mask.getW(i)).toBe(0);
    }
    geometry.setAttribute(
      '_terrain_flexibility',
      new THREE.Float32BufferAttribute([0, 1], 1),
    );
    expect(() => validateFlexibilityAttribute(geometry)).toThrow(/per vertex/);
    geometry.dispose();
  });
  it('decodes normalized custom GLB attributes and rejects malformed masks before import commits', async () => {
    const decoded = await decodeModel(maskedGLB());
    const part = decoded.parts[0],
      geometry = part.geometry.clone().applyMatrix4(part.matrix);
    expect(
      part.geometry.getAttribute('_terrain_flexibility').getX(1),
    ).toBeCloseTo(128 / 255);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.y).toBe(3);
    expect(geometry.boundingBox!.max.y).toBe(11);
    prepareFlexibility(
      geometry,
      { ...ramp, source: 'attribute', exponent: 1 },
      geometry.boundingBox!,
    );
    expect(geometry.getAttribute('terrainFlexibility').getX(1)).toBeCloseTo(
      128 / 255,
    );
    geometry.dispose();
    decoded.dispose();
    await expect(decodeModel(maskedGLB([0, -0.1, 1], false))).rejects.toThrow(
      /between 0 and 1/,
    );
    await expect(decodeModel(maskedGLB([0, NaN, 1], false))).rejects.toThrow(
      /finite/,
    );
    await expect(
      decodeModel(maskedGLB([0, 128, 255], true, 2)),
    ).rejects.toThrow(/one scalar/);
  });
  it('shares vertex storage across tiles while keeping contact buffers and mask variants independent', () => {
    const { project, model } = fixture();
    project.brushes[0].models!.push({
      ...model,
      id: 'rigid-low',
      flexibility: { ...ramp, start: 0.6 },
    });
    project.foliage.push({
      ...project.foliage[0],
      id: 4,
      modelId: 'rigid-low',
      x: 5,
    });
    project.nextId = 5;
    const scene = new TerrainScene(project);
    scene.rebuildFoliage();
    const batches = scene.foliage.children as THREE.InstancedMesh[];
    const trunks = batches.filter(
      (mesh) =>
        mesh.userData.modelId === model.id &&
        mesh.geometry.getAttribute('position').count ===
          batches[0].geometry.getAttribute('position').count,
    );
    expect(trunks).toHaveLength(2);
    expect(trunks[0].geometry).not.toBe(trunks[1].geometry);
    expect(trunks[0].geometry.getAttribute('position')).toBe(
      trunks[1].geometry.getAttribute('position'),
    );
    expect(trunks[0].geometry.getAttribute('terrainContact')).not.toBe(
      trunks[1].geometry.getAttribute('terrainContact'),
    );
    const different = batches.find(
      (mesh) => mesh.userData.modelId === 'rigid-low',
    )!;
    expect(different.geometry.getAttribute('terrainFlexibility')).not.toBe(
      trunks[0].geometry.getAttribute('terrainFlexibility'),
    );
    expect(
      [...different.geometry.getAttribute('terrainFlexibility').array].every(
        (value) => value === 0,
      ),
    ).toBe(true);
    const initial = trunks[0].instanceMatrix.array.slice(),
      version = trunks[0].instanceMatrix.version;
    scene.update(1 / 60, [{ x: 1, z: 1, radius: 2, strength: 1 }]);
    expect(trunks[0].instanceMatrix.array).toEqual(initial);
    expect(trunks[0].instanceMatrix.version).toBe(version);
    expect(
      trunks[0].geometry.getAttribute('terrainContact').getX(0),
    ).toBeGreaterThan(0);
    expect(trunks[0].geometry.getAttribute('terrainContact').getX(1)).toBe(0);
    expect(trunks[1].geometry.getAttribute('terrainContact').getX(0)).toBe(0);
    expect(
      scene.library.get('pine')[0].geometry.hasAttribute('terrainFlexibility'),
    ).toBe(false);
    const exported = scene.foliage.forExport();
    const geometries = new Set<THREE.BufferGeometry>();
    for (const mesh of exported.children as THREE.InstancedMesh[]) {
      expect(mesh.geometry.hasAttribute('terrainContact')).toBe(false);
      expect(mesh.geometry.hasAttribute('terrainFlexibility')).toBe(false);
      expect(mesh.geometry).not.toBe(batches[0].geometry);
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        material.dispose();
      mesh.dispose();
    }
    geometries.forEach((geometry) => geometry.dispose());
    scene.clearInteractions();
    expect(trunks[0].geometry.getAttribute('terrainContact').getX(0)).toBe(0);
    scene.dispose();
  });
  it('packs current contact into LODs, recovers while culled, and refits bounds for stronger wind', () => {
    const { project, model } = fixture();
    model.lods = [{ model: 'pine-low', distance: 10, density: 1 }];
    model.cullDistance = 50;
    model.lodHysteresis = 0;
    project.foliage = [project.foliage[0]];
    project.wind.strength = 0;
    const scene = new TerrainScene(project);
    scene.rebuildFoliage();
    const primary = scene.foliage.children[0] as THREE.InstancedMesh;
    const bound = primary.boundingSphere!.radius;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 0, 1);
    camera.updateMatrixWorld();
    scene.update(1 / 60, [{ x: 1, z: 1, radius: 2, strength: 1 }], camera);
    const amount = primary.geometry.getAttribute('terrainContact').getX(0);
    camera.position.z = 25;
    camera.updateMatrixWorld();
    scene.update(0, [], camera);
    const lod = scene.foliage.children.find(
      (mesh) => mesh.userData.lodLevel === 1,
    ) as THREE.InstancedMesh;
    expect(primary.count).toBe(0);
    expect(lod.count).toBe(1);
    expect(lod.geometry.getAttribute('terrainContact').getX(0)).toBe(amount);
    camera.position.z = 100;
    camera.updateMatrixWorld();
    scene.update(0, [], camera);
    expect(lod.count).toBe(0);
    scene.update(20);
    camera.position.z = 1;
    camera.updateMatrixWorld();
    project.wind.enabled = true;
    project.wind.strength = 10;
    scene.update(0, [], camera);
    expect(primary.count).toBe(1);
    expect(
      primary.geometry.getAttribute('terrainContact').getX(0),
    ).toBeLessThan(amount);
    expect(primary.boundingSphere!.radius).toBeGreaterThan(bound);
    const matrix = new THREE.Matrix4();
    primary.getMatrixAt(0, matrix);
    expect(matrix.elements[13]).toBe(0);
    project.heights.fill(3);
    scene.foliage.reanchor({ minX: 0, maxX: 2, minZ: 0, maxZ: 2 });
    primary.getMatrixAt(0, matrix);
    expect(matrix.elements[13]).toBe(3);
    scene.dispose();
  });
  it('bounds pending GPU upload ranges while batches remain outside the render frustum', () => {
    for (const masked of [false, true]) {
      const { project, model } = fixture();
      if (!masked) delete model.flexibility;
      const scene = new TerrainScene(project);
      scene.rebuildFoliage();
      for (let frame = 0; frame < 200; frame++) {
        project.heights.fill(frame / 100);
        scene.foliage.reanchor({ minX: -64, maxX: 64, minZ: -64, maxZ: 64 });
      }
      for (const mesh of scene.foliage.children as THREE.InstancedMesh[]) {
        expect(mesh.instanceMatrix.updateRanges).toHaveLength(1);
        expect(mesh.instanceMatrix.updateRanges[0]).toEqual({
          start: 0,
          count: mesh.instanceMatrix.array.length,
        });
        if (masked)
          expect(
            (
              mesh.geometry.getAttribute(
                'terrainContact',
              ) as THREE.BufferAttribute
            ).updateRanges,
          ).toHaveLength(1);
      }
      scene.dispose();
    }
  });
});
