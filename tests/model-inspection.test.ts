import { expect, it } from 'vitest';
import * as THREE from 'three';
import {
  inspectModel,
  modelInspectionHTML,
} from '../src/editor/model-inspection';

it('counts indexed and nonindexed mesh placements and deduplicates packed texture images', () => {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const image = { width: 2048, height: 1024 };
  const map = new THREE.Texture(image);
  map.name = 'Packed ORM';
  const alias = map.clone();
  const material = new THREE.MeshStandardMaterial({
    roughnessMap: map,
    metalnessMap: alias,
    aoMap: map,
  });
  const parts = [geometry, geometry.toNonIndexed()].map((geometry) => ({
    geometry,
    material,
    matrix: new THREE.Matrix4(),
  }));
  const info = inspectModel(parts);
  expect(info).toMatchObject({
    triangles: 4,
    vertices: 10,
    parts: 2,
    materials: 1,
    textures: [
      { name: 'Packed ORM', width: 2048, height: 1024, compressed: false },
    ],
  });
  expect(info.textures[0].usages.sort()).toEqual([
    'Metallic',
    'Occlusion',
    'Roughness',
  ]);
  // Inspection must not dispose resources or copy image pixels.
  expect(map.source.data).toBe(image);
  expect(alias.source).toBe(map.source);
  parts.forEach((part) => part.geometry.dispose());
  material.dispose();
  map.dispose();
  alias.dispose();
});

it('reports compressed dimensions, unknown dimensions and safely escaped texture names', () => {
  const compressed = new THREE.CompressedTexture([], 4096, 2048);
  compressed.name = '<script>artist</script>';
  const normal = new THREE.Texture();
  normal.name = 42 as unknown as string; // Some exporters write malformed optional names.
  const material = new THREE.MeshStandardMaterial({
    map: compressed,
    normalMap: normal,
  });
  const geometry = new THREE.PlaneGeometry(1, 1);
  const info = inspectModel([
    { geometry, material: [material], matrix: new THREE.Matrix4() },
  ]);
  expect(info.textures[0]).toMatchObject({
    width: 4096,
    height: 2048,
    compressed: true,
  });
  expect(info.textures[1].width).toBeUndefined();
  expect(info.textures[1].name).toBe('Texture 2');
  const html = modelInspectionHTML(info);
  expect(html).toContain('4,096 × 2,048 px');
  expect(html).toContain('Compressed');
  expect(html).toContain('Size unavailable');
  expect(html).toContain('&lt;script&gt;artist&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  geometry.dispose();
  material.dispose();
  compressed.dispose();
  normal.dispose();
});
