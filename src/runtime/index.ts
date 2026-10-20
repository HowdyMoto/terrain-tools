export {
  createTerrainRenderer,
  isWebGPU,
  rendererDescription,
} from '../render/renderer';
export type { TerrainRenderer } from '../render/renderer';
export {
  TerrainEnvironment,
  prepareEnvironment,
  PreparedEnvironment,
  validateEnvironmentHDR,
  validateEnvironmentEXR,
  MAX_ENVIRONMENT_BYTES,
} from './environment';
export { TerrainScene } from './terrain-scene';
export { WorldAssets } from './world-assets';
export { RuntimeMaterialLibrary } from './material-library';
export type {
  MaterialLibraryManifest,
  PreparedMapFile,
} from './material-library';
export { modelMemory } from './asset-memory';
export { createModelDecoder } from '../render/model-loader';
export type { ModelDecoder, DecodedModel } from '../render/model-loader';
export { TerrainLod } from './terrain-lod';
export { webOceanResources } from './web-ocean/simulation';
export type { TerrainLodOptions } from './terrain-lod';
export { TerrainWorldScene } from './world-scene';
export type {
  WorldSceneOptions,
  WorldCollisionSource,
  WorldColliders,
} from './world-scene';
export { configureFoliageSubsurface } from './foliage-shading';
export type { EditTransaction } from '../render/edit-transaction';
export type { PreparedTerrain, PreparedTerrainGeometry } from './terrain-scene';
import { checkSignal, cancelled } from '../render/resources';
export type { TerrainRegion, CollisionMesh } from './terrain-scene';
export { exportTerrainGLB } from './export';
export type { TerrainExportOptions } from './export';
export { bakeTerrainSurface } from './bake-material';
export type {
  TerrainBakeOptions,
  TerrainBakeResolution,
  BakedTerrainSurface,
} from './bake-material';
export type { GroundContact } from '../core/interaction';
import { TerrainScene } from './terrain-scene';
import { parseProjectFile, readProjectFile } from '../core/glb-project';
export async function loadTerrain(
  input: string | ArrayBuffer | Blob,
  options: {
    signal?: AbortSignal;
    assets?: import('./world-assets').WorldAssets;
    decoder?: import('../render/model-loader').ModelDecoder;
  } = {},
) {
  checkSignal(options.signal);
  const project =
    input instanceof Blob
      ? await readProjectFile(input)
      : parseProjectFile(input);
  checkSignal(options.signal);
  const terrain = new TerrainScene(project, options);
  try {
    if (!(await terrain.load(terrain.project, true, options.signal)))
      throw cancelled();
    return terrain;
  } catch (error) {
    terrain.dispose();
    throw error;
  }
}
export type { FoliageViewStats } from './foliage';
export type { FoliageClusterOptions } from './foliage-clusters';

export { bakeFoliageImpostor } from './foliage-impostor';
export type {
  FoliageImpostor,
  FoliageImpostorOptions,
} from './foliage-impostor';

export { shaderCacheStats } from '../render/shader-cache';
