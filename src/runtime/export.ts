import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { serializeProjectPackage } from '../core/project-package';
import { embedProjectPackage } from '../core/glb-project';
import { checkSignal } from '../render/resources';
import { bakeTerrainSurface, terrainExportGeometry } from './bake-material';
import type {
  TerrainBakeResolution,
  BakedTerrainSurface,
} from './bake-material';
import type { TerrainScene } from './terrain-scene';

export interface TerrainExportOptions {
  /** 'colors' is the small, fast legacy presentation. 'pbr' bakes standard texture maps. */
  surface?: 'colors' | 'pbr';
  /** Required for PBR baking; remains usable for animation between bake passes. */
  renderer?: THREE.WebGLRenderer;
  resolution?: TerrainBakeResolution;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
/** Standard static presentation + editable project. Keep the source alive and unchanged until resolved. */
export async function exportTerrainGLB(
  scene: TerrainScene,
  options: TerrainExportOptions = {},
): Promise<ArrayBuffer> {
  const { signal, onProgress } = options;
  checkSignal(signal);
  if (
    options.surface !== undefined &&
    !['colors', 'pbr'].includes(options.surface)
  )
    throw new Error('Unknown GLB surface export mode.');
  if (options.surface === 'pbr' && !options.renderer)
    throw new Error('PBR export requires a WebGL renderer.');
  const authored = serializeProjectPackage(scene.project);
  const group = new THREE.Group();
  group.name = scene.project.name;
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>();
  let foliage: THREE.Group | undefined, baked: BakedTerrainSurface | undefined;
  try {
    if (options.surface === 'pbr')
      baked = await bakeTerrainSurface(scene, {
        renderer: options.renderer!,
        resolution: options.resolution,
        signal,
        onProgress,
      });
    checkSignal(signal);
    onProgress?.('Preparing scene geometry…');
    for (const object of scene.terrain.children) {
      const mesh = object as THREE.Mesh;
      const geometry = baked
        ? terrainExportGeometry(
            mesh.geometry,
            scene.project.size,
            scene.project.view.lowPoly,
          )
        : mesh.geometry.clone();
      geometries.add(geometry);
      let material: THREE.MeshStandardMaterial;
      if (baked) material = baked.material;
      else {
        const weights = geometry.getAttribute('layerWeights'),
          colors = new Float32Array(weights.count * 3);
        for (let i = 0; i < weights.count; i++) {
          const color = new THREE.Color(0, 0, 0);
          for (let layer = 0; layer < 4; layer++)
            color.add(
              new THREE.Color(
                scene.project.materials[layer].color,
              ).multiplyScalar(weights.array[i * 4 + layer]),
            );
          color.toArray(colors, i * 3);
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.85,
          flatShading: scene.project.view.lowPoly,
        });
        materials.add(material);
      }
      geometry.deleteAttribute('layerWeights');
      const exported = new THREE.Mesh(geometry, material);
      exported.name = mesh.name;
      group.add(exported);
    }
    foliage = scene.foliage.forExport();
    group.add(scene.props.clone(true), foliage);
    if (scene.water.visible) group.add(scene.water.clone());
    for (const water of scene.waterSystem.forExport()) {
      geometries.add(water.geometry);
      materials.add(water.material as THREE.Material);
      group.add(water);
    }
    checkSignal(signal);
    onProgress?.('Encoding GLB…');
    const presentation = (await new GLTFExporter().parseAsync(group, {
      binary: true,
      includeCustomExtensions: true,
    })) as ArrayBuffer;
    checkSignal(signal);
    const bytes = await authored.arrayBuffer();
    checkSignal(signal);
    return embedProjectPackage(presentation, bytes);
  } finally {
    foliage?.children.forEach((object) => {
      const mesh = object as THREE.InstancedMesh;
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        materials.add(material);
      mesh.dispose();
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    baked?.dispose();
  }
}
