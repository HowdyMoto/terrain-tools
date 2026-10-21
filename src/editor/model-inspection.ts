import * as THREE from 'three';
import type { ModelPart } from '../render/models';
import { escapeImportText as esc } from './import-dialog';

export interface ModelTextureInfo {
  name: string;
  width?: number;
  height?: number;
  usages: string[];
  compressed: boolean;
}
export interface ModelInspection {
  triangles: number;
  vertices: number;
  parts: number;
  materials: number;
  textures: ModelTextureInfo[];
}
const mapNames: Record<string, string> = {
  map: 'Base color',
  normalMap: 'Normal',
  roughnessMap: 'Roughness',
  metalnessMap: 'Metallic',
  aoMap: 'Occlusion',
  alphaMap: 'Opacity',
  emissiveMap: 'Emission',
  bumpMap: 'Bump',
  displacementMap: 'Displacement',
  transmissionMap: 'Transmission',
  thicknessMap: 'Thickness',
  clearcoatMap: 'Clearcoat',
  clearcoatNormalMap: 'Clearcoat normal',
  clearcoatRoughnessMap: 'Clearcoat roughness',
};

/** Inspect decoded rest-pose meshes without reading pixels or retaining GPU resources.
 * Triangle/vertex totals include each mesh placement; shared texture sources count once.
 */
export function inspectModel(parts: readonly ModelPart[]): ModelInspection {
  let triangles = 0,
    vertices = 0;
  const materials = new Set<THREE.Material>();
  const textures = new Map<THREE.Texture['source'], ModelTextureInfo>();
  for (const part of parts) {
    const positions = part.geometry.getAttribute('position')?.count ?? 0;
    vertices += positions;
    triangles += Math.floor((part.geometry.index?.count ?? positions) / 3);
    for (const material of Array.isArray(part.material)
      ? part.material
      : [part.material]) {
      if (materials.has(material)) continue;
      materials.add(material);
      for (const [slot, value] of Object.entries(material)) {
        if (!(value instanceof THREE.Texture)) continue;
        let texture = textures.get(value.source);
        if (!texture) {
          const image = value.image as
            | {
                width?: number;
                height?: number;
                naturalWidth?: number;
                naturalHeight?: number;
              }
            | undefined;
          const dimension = (size: unknown) =>
            typeof size === 'number' && Number.isFinite(size) && size > 0
              ? size
              : undefined;
          texture = {
            name:
              typeof value.name === 'string' && value.name
                ? value.name
                : `Texture ${textures.size + 1}`,
            width: dimension(image?.naturalWidth ?? image?.width),
            height: dimension(image?.naturalHeight ?? image?.height),
            usages: [],
            compressed: false,
          };
          textures.set(value.source, texture);
        }
        const usage = mapNames[slot] ?? slot.replace(/Map$/, '');
        if (!texture.usages.includes(usage)) texture.usages.push(usage);
        texture.compressed ||= value instanceof THREE.CompressedTexture;
      }
    }
  }
  return {
    triangles,
    vertices,
    parts: parts.length,
    materials: materials.size,
    textures: [...textures.values()],
  };
}

/** Shared import-preview and selected-asset readout. Values describe one model, not the whole scene. */
export function modelInspectionHTML(info: ModelInspection) {
  return `<div class="model-inspection" aria-label="Model geometry and textures">
    <dl class="model-metrics"><div><dt>Polygons · triangles</dt><dd data-model-triangles>${info.triangles.toLocaleString()}</dd></div><div><dt>Vertices</dt><dd>${info.vertices.toLocaleString()}</dd></div><div><dt>Mesh parts</dt><dd>${info.parts.toLocaleString()}</dd></div><div><dt>Materials</dt><dd>${info.materials.toLocaleString()}</dd></div></dl>
    <h4>Textures <span>${info.textures.length}</span></h4>
    ${info.textures.length ? `<ul class="model-textures">${info.textures.map((texture) => `<li><div><strong>${esc(texture.name)}</strong><span>${esc(texture.usages.join(' · '))}${texture.compressed ? ' · Compressed' : ''}</span></div><b data-texture-size>${texture.width && texture.height ? `${texture.width.toLocaleString()} × ${texture.height.toLocaleString()} px` : 'Size unavailable'}</b></li>`).join('')}</ul><p class="field-note">Shared image sources count once, including packed material maps.</p>` : '<p class="field-note">No texture maps.</p>'}
    <p class="field-note">Counts for one model. glTF stores polygons as triangles.</p>
  </div>`;
}
