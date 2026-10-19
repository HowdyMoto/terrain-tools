import { sampleHeightmap, validateHeightmap } from './heightmap';
import type { Heightmap } from './heightmap';

export interface OrmSources {
  occlusion?: Heightmap;
  roughness?: Heightmap;
  metalness?: Heightmap;
  /** Treat the roughness source as gloss/smoothness: output is 1 minus its sample. */
  roughnessIsGloss?: boolean;
}
/** Numeric linear channels: R = AO, G = roughness, B = metalness, A = 255. Missing channels are 1. */
export function packOrmMap(
  sources: OrmSources,
  width: number,
  height = width,
): Uint8Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 2048 ||
    height > 2048
  )
    throw new Error('ORM output dimensions must be between 1 and 2048.');
  if (
    sources.roughnessIsGloss !== undefined &&
    typeof sources.roughnessIsGloss !== 'boolean'
  )
    throw new Error('Invalid gloss setting.');
  const maps = [sources.occlusion, sources.roughness, sources.metalness];
  for (const map of maps) if (map) validateHeightmap(map);
  const result = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = width === 1 ? 0.5 : x / (width - 1),
        v = height === 1 ? 0.5 : y / (height - 1);
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const map = maps[channel];
        let value = map ? sampleHeightmap(map, u, v) : 1;
        if (map && channel === 1 && sources.roughnessIsGloss) value = 1 - value;
        result[at + channel] = Math.round(value * 255);
      }
      result[at + 3] = 255;
    }
  return result;
}
