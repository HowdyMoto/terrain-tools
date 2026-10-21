import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createProject,
  editFoliageModels,
  parseProject,
  serializeProject,
  serializeProjectPackage,
  parseProjectFile,
  serializeFoliageBrush,
  importFoliageBrush,
  defaultFoliageSubsurface,
  parseFoliageSubsurface,
} from '../src/index';
import { configureFoliageSubsurface } from '../src/runtime/foliage-shading';
import { configureWind, windUniforms } from '../src/runtime/wind';
import { configureFoliageFade } from '../src/runtime/foliage-fade';
import { TerrainScene } from '../src/runtime/terrain-scene';

describe('leaf subsurface lighting', () => {
  it('smooths imported cutouts without transmission, preserves source materials and honors the edge opt-out', () => {
    const p = createProject(8, 16);
    p.heights.fill(0);
    const model = editFoliageModels(p.brushes[0], [])[0];
    model.model = 'grass';
    p.foliage = [
      {
        id: 1,
        brushId: p.brushes[0].id,
        modelId: model.id,
        x: 0,
        z: 0,
        scale: 1,
        rotation: 0,
      },
    ];
    const scene = new TerrainScene(p);
    const source = scene.library.get('grass')[0]
      .material as THREE.MeshStandardMaterial;
    source.alphaTest = 0.5;
    scene.rebuildFoliage();
    const drawn = () =>
      (scene.foliage.children[0] as THREE.InstancedMesh)
        .material as THREE.Material;
    expect(drawn().alphaToCoverage).toBe(true);
    expect(source.alphaToCoverage).toBe(false);
    model.subsurface = { ...defaultFoliageSubsurface(), smoothEdges: false };
    scene.rebuildFoliage();
    expect(drawn().alphaToCoverage).toBe(false);
    delete model.subsurface;
    source.transparent = true;
    scene.rebuildFoliage();
    expect(drawn().alphaToCoverage).toBe(false);
    scene.dispose();
  });
  it('preserves legacy appearance and persists settings through documents and brushes', async () => {
    const p = createProject(8, 16);
    const model = editFoliageModels(p.brushes[0], [])[0];
    expect(
      parseProject(serializeProject(p)).brushes[0].models![0].subsurface,
    ).toBeUndefined();
    model.subsurface = {
      ...defaultFoliageSubsurface(),
      tint: '#bfe28a',
      thickness: 0.7,
      materials: ['leaves'],
    };
    expect(parseProject(serializeProject(p))).toEqual(p);
    expect(
      parseProjectFile(await serializeProjectPackage(p).arrayBuffer()),
    ).toEqual(p);
    const imported = importFoliageBrush(
      createProject(8, 16),
      serializeFoliageBrush(p, p.brushes[0].id),
    );
    expect(imported.brushes.at(-1)!.models![0].subsurface).toEqual(
      model.subsurface,
    );
  });
  it('rejects malformed and out-of-range leaf settings before loading', () => {
    const p = createProject(8, 16);
    const model = editFoliageModels(p.brushes[0], [])[0];
    for (const patch of [
      { strength: 1.01 },
      { strength: -0.1 },
      { strength: '0.5' },
      { thickness: Infinity },
      { thickness: -1 },
      { thickness: 4.1 },
      { wrap: 2 },
      { tint: 'green' },
      { mode: 'glass' },
      { smoothEdges: 1 },
      { materials: [1] },
      { materials: ['leaf', 'leaf'] },
    ]) {
      const candidate = { ...defaultFoliageSubsurface(), ...patch };
      expect(() => parseFoliageSubsurface(candidate)).toThrow('subsurface');
      model.subsurface = candidate as typeof model.subsurface;
      expect(() => parseProject(serializeProject(p))).toThrow('subsurface');
    }
    expect(() => parseFoliageSubsurface(null)).toThrow('subsurface');
  });
  it('keeps opaque bark standard and composes leaf shading with wind and LOD fades', () => {
    const bark = new THREE.MeshStandardMaterial();
    const original = bark.onBeforeCompile;
    configureFoliageSubsurface(bark, defaultFoliageSubsurface());
    expect(bark.onBeforeCompile).toBe(original);
    expect(bark.side).toBe(THREE.FrontSide);
    const leaf = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
    configureWind(leaf, 0.3, windUniforms(), 0);
    configureFoliageSubsurface(leaf, defaultFoliageSubsurface());
    configureFoliageFade(leaf);
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as Parameters<typeof leaf.onBeforeCompile>[0];
    leaf.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('foliageDeformation');
    expect(shader.fragmentShader).toContain('RE_Direct_TerrainLeaf');
    expect(shader.fragmentShader).toContain('terrainNoise');
    expect(shader.uniforms).toHaveProperty('terrainLeafStrength.value', 0.6);
    expect(leaf.customProgramCacheKey()).toContain('terrain-leaf-v1');
    expect(leaf.customProgramCacheKey()).toContain('terrain-flexibility-v1');
    expect(leaf.side).toBe(THREE.DoubleSide);
    expect(leaf.alphaToCoverage).toBe(true);
    configureFoliageSubsurface(bark, {
      ...defaultFoliageSubsurface(),
      mode: 'all',
    });
    expect(bark.side).toBe(THREE.DoubleSide);
    expect(bark.alphaToCoverage).toBe(false);
    const twig = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
    twig.name = 'twig';
    const twigCompile = twig.onBeforeCompile;
    configureFoliageSubsurface(twig, {
      ...defaultFoliageSubsurface(),
      materials: ['leaf'],
    });
    expect(twig.onBeforeCompile).toBe(twigCompile);
    twig.dispose();
    bark.dispose();
    leaf.dispose();
  });
});
