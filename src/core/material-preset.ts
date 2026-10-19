import { createProject } from './terrain';
import { validateProjectData } from './serialization';
import type { MaterialLayer, TerrainProject } from './types';

/** One portable layer; destination identity and project-wide resolution are not included. */
export interface MaterialPreset {
  material: Omit<MaterialLayer, 'id'>;
}
export interface MaterialPresetOptions {
  /** False by default: retain the destination altitude/slope ranges and feather. */
  applyPlacementRules?: boolean;
}
/** Bounds synchronous JSON parsing independently of texture import limits. */
export const MAX_MATERIAL_PRESET_BYTES = 128 * 1024 * 1024;

function checkedMaterial(raw: unknown): MaterialPreset['material'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid surface preset material.');
  // Share the project validator so supported material settings cannot diverge.
  const project = createProject(8, 8);
  const material = { ...raw, id: project.materials[0].id };
  const validated = validateProjectData({
    ...project,
    materials: [material, ...project.materials.slice(1)],
  }).materials[0];
  // Copy only portable settings; exclude identity and unrelated extension data.
  return {
    name: validated.name,
    color: validated.color,
    roughness: validated.roughness,
    metalness: validated.metalness,
    minHeight: validated.minHeight,
    maxHeight: validated.maxHeight,
    minSlope: validated.minSlope,
    maxSlope: validated.maxSlope,
    feather: validated.feather,
    tileSize: validated.tileSize,
    ...(validated.reduceTiling !== undefined
      ? { reduceTiling: validated.reduceTiling }
      : {}),
    blendHeight: validated.blendHeight,
    ...(validated.normalStrength !== undefined
      ? { normalStrength: validated.normalStrength }
      : {}),
    ...(validated.normalConvention !== undefined
      ? { normalConvention: validated.normalConvention }
      : {}),
    ...(validated.proceduralVariant !== undefined
      ? { proceduralVariant: validated.proceduralVariant }
      : {}),
    textures: { ...validated.textures },
  };
}
function checkSize(text: string) {
  if (
    text.length > MAX_MATERIAL_PRESET_BYTES ||
    new Blob([text]).size > MAX_MATERIAL_PRESET_BYTES
  )
    throw new Error('Surface preset exceeds the 128 MiB file limit.');
}
/** Embeds the selected layer's maps and rules, without terrain or model assets. */
export function serializeMaterialPreset(
  project: TerrainProject,
  materialId: string,
): string {
  const index = project.materials.findIndex(
    (material) => material.id === materialId,
  );
  if (index < 0) throw new Error('Unknown surface layer.');
  const material = project.materials[index];
  const text = JSON.stringify({
    kind: 'terrain-material-preset',
    version: 1,
    material: checkedMaterial({
      ...material,
      proceduralVariant: material.proceduralVariant ?? index,
    }),
  });
  checkSize(text);
  return text;
}
/** Validate before decoding images or changing a project. Images are decoded by the rendering host. */
export function parseMaterialPreset(text: string): MaterialPreset {
  checkSize(text);
  const raw = JSON.parse(text);
  if (!raw || raw.kind !== 'terrain-material-preset' || raw.version !== 1)
    throw new Error('Unsupported surface preset file.');
  return { material: checkedMaterial(raw.material) };
}
/** Return an independently owned replacement while preserving the destination layer ID. */
export function applyMaterialPreset(
  target: MaterialLayer,
  preset: MaterialPreset,
  options: MaterialPresetOptions = {},
): MaterialLayer {
  if (
    options.applyPlacementRules !== undefined &&
    typeof options.applyPlacementRules !== 'boolean'
  )
    throw new Error('Invalid surface preset placement option.');
  if (
    typeof target.id !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,63}$/i.test(target.id)
  )
    throw new Error('Invalid destination material identifier.');
  const material = checkedMaterial(preset.material);
  return {
    ...checkedMaterial({
      ...material,
      ...(!options.applyPlacementRules
        ? {
            minHeight: target.minHeight,
            maxHeight: target.maxHeight,
            minSlope: target.minSlope,
            maxSlope: target.maxSlope,
            feather: target.feather,
          }
        : {}),
    }),
    id: target.id,
  };
}
