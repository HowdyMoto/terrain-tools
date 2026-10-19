export {
  TerrainEnvironment,
  prepareEnvironment,
  PreparedEnvironment,
  validateEnvironmentHDR,
  validateEnvironmentEXR,
  MAX_ENVIRONMENT_BYTES,
} from './environment';
export { TerrainScene } from './terrain-scene';
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
  options: { signal?: AbortSignal } = {},
) {
  checkSignal(options.signal);
  const project =
    input instanceof Blob
      ? await readProjectFile(input)
      : parseProjectFile(input);
  checkSignal(options.signal);
  const terrain = new TerrainScene(project);
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
