import { editFoliageModels } from '../src/core/foliage';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TerrainScene } from '../src/runtime/terrain-scene';
import {
  createProject,
  generateTerrain,
  applyBrush,
} from '../src/core/terrain';
import { serializeProject } from '../src/core/serialization';
import { PROJECT_EXTENSION, projectFromGLB } from '../src/core/glb-project';

function documentGLB(project: unknown) {
  const json = JSON.stringify({
    asset: { version: '2.0' },
    nodes: [{ extensions: { [PROJECT_EXTENSION]: { version: 1, project } } }],
  });
  const data = new TextEncoder().encode(
      json.padEnd(Math.ceil(json.length / 4) * 4, ' '),
    ),
    buffer = new ArrayBuffer(20 + data.length),
    v = new DataView(buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, buffer.byteLength, true);
  v.setUint32(12, data.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).set(data);
  return buffer;
}

describe('portable scene data', () => {
  it('restores all authored data from the GLB extension', () => {
    const p = createProject(16, 32);
    p.view.textureResolution = 1024;
    p.materials[1].normalStrength = 2;
    p.props.push({
      id: p.nextId++,
      model: 'portal',
      x: 0,
      z: 0,
      yOffset: 1,
      scale: 1,
      rotation: 0.4,
      cutHole: true,
      holeRadius: 3,
    });
    expect(
      projectFromGLB(documentGLB(JSON.parse(serializeProject(p)))),
    ).toEqual(p);
  });
  it('rejects truncated GLBs and validates the embedded document', () => {
    expect(() => projectFromGLB(new ArrayBuffer(12))).toThrow('size');
    const p = createProject(16, 32),
      data = JSON.parse(serializeProject(p));
    data.brushes[0].model = 'unknown';
    expect(() => projectFromGLB(documentGLB(data))).toThrow('model reference');
    const buffer = documentGLB(JSON.parse(serializeProject(p)));
    new DataView(buffer).setUint32(8, 999999, true);
    expect(() => projectFromGLB(buffer)).toThrow('header');
  });
});

describe('Three.js runtime geometry', () => {
  it('refreshes water and shading without replacing geometry or resetting foliage contact', () => {
    const p = createProject(64, 64);
    generateTerrain(p, 'flat');
    p.foliage = [
      { id: 1, brushId: 'grass', x: 0, z: 0, scale: 1, rotation: 0 },
    ];
    const scene = new TerrainScene(p);
    scene.rebuildTerrain();
    scene.rebuildFoliage();
    scene.update(0.1, [{ x: 0, z: 0, radius: 3, strength: 1 }]);
    const terrain = [...scene.terrain.children] as THREE.Mesh[];
    const geometry = terrain.map((mesh) => mesh.geometry);
    const foliage = scene.foliage.children[0] as THREE.InstancedMesh;
    const contact = foliage.instanceMatrix.array.slice();
    const material = scene.terrainMaterial.material;
    const version = material.version;
    p.view = {
      ...p.view,
      water: true,
      waterLevel: 4,
      lowPoly: !material.flatShading,
      wireframe: true,
    };
    scene.refreshView();
    expect(scene.water.visible).toBe(true);
    expect(scene.water.position.y).toBe(4);
    expect(scene.water.scale.toArray()).toEqual([64, 64, 1]);
    expect(material.flatShading).toBe(p.view.lowPoly);
    expect(material.wireframe).toBe(true);
    expect(material.version).toBe(version + 1);
    scene.refreshView();
    expect(material.version).toBe(version + 1);
    terrain.forEach((mesh, index) => {
      expect(scene.terrain.children[index]).toBe(mesh);
      expect(mesh.geometry).toBe(geometry[index]);
    });
    expect(scene.foliage.children[0]).toBe(foliage);
    expect(foliage.instanceMatrix.array).toEqual(contact);
    p.view.water = false;
    p.view.wireframe = false;
    scene.refreshView();
    expect(scene.water.visible).toBe(false);
    expect(material.wireframe).toBe(false);
    scene.dispose();
    expect(() => scene.refreshView()).toThrow('disposed');
  });
  it('regional edits match a full rebuild while retaining untouched geometry', () => {
    const p = createProject(128, 128);
    generateTerrain(p, 'flat');
    const scene = new TerrainScene(p);
    scene.rebuildTerrain();
    const original = new Map(
      scene.terrain.children.map((m) => [m.name, (m as THREE.Mesh).geometry]),
    );
    applyBrush(p, {
      tool: 'raise',
      x: -40,
      z: -40,
      radius: 4,
      strength: 3,
      falloff: 0.5,
      target: 0,
      material: 0,
      brushId: 'pine',
      seed: 42,
    });
    const changed = scene.rebuildTerrain({
      minX: -44,
      maxX: -36,
      minZ: -44,
      maxZ: -36,
    });
    expect(changed.length).toBeLessThan(scene.terrain.children.length / 2);
    const reference = new TerrainScene(p);
    reference.rebuildTerrain();
    for (const mesh of scene.terrain.children as THREE.Mesh[]) {
      const full = reference.terrain.getObjectByName(mesh.name) as THREE.Mesh;
      expect(mesh.geometry.getAttribute('position').array).toEqual(
        full.geometry.getAttribute('position').array,
      );
      expect(mesh.geometry.getAttribute('normal').array).toEqual(
        full.geometry.getAttribute('normal').array,
      );
      expect(mesh.geometry.getAttribute('layerWeights').array).toEqual(
        full.geometry.getAttribute('layerWeights').array,
      );
      if (!changed.includes(mesh))
        expect(mesh.geometry).toBe(original.get(mesh.name));
    }
    scene.dispose();
    reference.dispose();
  });
  it('extracts transformed prop geometry and keeps holes in terrain collision', () => {
    const p = createProject(16, 32);
    generateTerrain(p, 'flat');
    p.holes[0] = 1;
    p.props = [
      {
        id: 1,
        model: 'platform',
        x: 0,
        z: 0,
        yOffset: 2,
        scale: 2,
        rotation: 0,
        cutHole: false,
        holeRadius: 4,
      },
    ];
    const scene = new TerrainScene(p);
    scene.rebuildTerrain();
    scene.rebuildProps();
    scene.position.set(10, 3, 5);
    const terrain = scene.collisionMeshes(false),
      props = scene.collisionMeshes(true, false);
    expect(terrain[0].indices.length).toBe(255 * 6);
    expect(props).toHaveLength(1);
    const ys = Array.from(props[0].positions).filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBeCloseTo(6.6);
    expect(Math.min(...ys)).toBeCloseTo(5.4);
    scene.dispose();
  });
  it('shares wind deformation with both shadow passes and updates compressed instances', () => {
    const p = createProject(16, 32);
    generateTerrain(p, 'flat');
    p.foliage = [
      { id: 1, brushId: 'grass', x: 0, z: 0, scale: 1, rotation: 0 },
    ];
    const scene = new TerrainScene(p);
    scene.rebuildFoliage();
    const mesh = scene.foliage.children[0] as THREE.InstancedMesh;
    expect(mesh.castShadow).toBe(true);
    expect(mesh.customDepthMaterial).toBeDefined();
    expect(mesh.customDistanceMaterial).toBeDefined();
    expect(mesh.frustumCulled).toBe(true);
    const before = mesh.instanceMatrix.array.slice();
    scene.update(1 / 60, [{ x: 0, z: 0, radius: 4, strength: 1 }]);
    expect(mesh.instanceMatrix.array).not.toEqual(before);
    scene.clearInteractions();
    expect(mesh.instanceMatrix.array).toEqual(before);
    scene.dispose();
  });
});

it('keeps generated world height independent of grid resolution', () => {
  const a = createProject(16, 32),
    b = createProject(32, 32);
  for (let z = 0; z <= 16; z++)
    for (let x = 0; x <= 16; x++)
      expect(a.heights[z * 17 + x]).toBeCloseTo(
        b.heights[z * 2 * 33 + x * 2],
        5,
      );
});

it('renders each mixture model with independent wind and contact response', () => {
  const p = createProject(16, 32);
  generateTerrain(p, 'flat');
  const b = p.brushes[0],
    models = editFoliageModels(b, p.foliage);
  Object.assign(models[0], { model: 'boulder', wind: 0, crush: 0 });
  models.push({
    ...models[0],
    id: 'grass',
    model: 'grass',
    wind: 1.5,
    crush: 1,
  });
  p.foliage = [
    {
      id: 1,
      brushId: b.id,
      modelId: 'primary',
      x: 1,
      z: 1,
      scale: 1,
      rotation: 0,
    },
    {
      id: 2,
      brushId: b.id,
      modelId: 'grass',
      x: 2,
      z: 1,
      scale: 0.8,
      rotation: 1,
    },
  ];
  p.nextId = 3;
  const scene = new TerrainScene(p);
  scene.rebuildFoliage();
  expect(scene.foliage.children).toHaveLength(2);
  const rock = scene.foliage.children.find(
    (m) => m.userData.model === 'boulder',
  ) as THREE.InstancedMesh;
  const grass = scene.foliage.children.find(
    (m) => m.userData.model === 'grass',
  ) as THREE.InstancedMesh;
  expect((rock.material as THREE.Material).customProgramCacheKey()).toMatch(
    /-0$/,
  );
  expect((grass.material as THREE.Material).customProgramCacheKey()).toMatch(
    /-1.5$/,
  );
  expect(grass.customDepthMaterial!.customProgramCacheKey()).toMatch(/-1.5$/);
  const rockMatrix = rock.instanceMatrix.array.slice(),
    grassMatrix = grass.instanceMatrix.array.slice();
  scene.update(1 / 60, [{ x: 2, z: 1, radius: 5, strength: 1 }]);
  expect(rock.instanceMatrix.array).toEqual(rockMatrix);
  expect(grass.instanceMatrix.array).not.toEqual(grassMatrix);
  scene.clearInteractions();
  expect(grass.instanceMatrix.array).toEqual(grassMatrix);
  models[0].weight = 0;
  scene.rebuildFoliage();
  expect(scene.foliage.children.map((m) => m.userData.model).sort()).toEqual([
    'boulder',
    'grass',
  ]);
  expect(projectFromGLB(documentGLB(JSON.parse(serializeProject(p))))).toEqual(
    p,
  );
  scene.dispose();
});
