import { clamp, lerp } from './math';
import type { TerrainProject } from './types';

export interface Heightmap {
  width: number;
  height: number;
  /** Row-major normalized data; the first row maps to negative terrain Z. */
  values: Float32Array;
}
export function validateHeightmap(map: Heightmap, maximum = 16_777_216) {
  if (
    !Number.isInteger(map.width) ||
    !Number.isInteger(map.height) ||
    map.width < 1 ||
    map.height < 1 ||
    map.width > 8192 ||
    map.height > 8192 ||
    map.width * map.height > maximum ||
    map.values.length !== map.width * map.height
  )
    throw new Error('Invalid heightmap dimensions or sample count.');
  for (const value of map.values)
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new Error(
        'Heightmap samples must be finite and between zero and one.',
      );
}
export function sampleHeightmap(map: Heightmap, u: number, v: number) {
  const x = clamp(u) * (map.width - 1),
    z = clamp(v) * (map.height - 1);
  const ix = Math.floor(x),
    iz = Math.floor(z);
  const a = iz * map.width + ix,
    b = iz * map.width + Math.min(ix + 1, map.width - 1);
  const c = Math.min(iz + 1, map.height - 1) * map.width + ix;
  const d =
    Math.min(iz + 1, map.height - 1) * map.width +
    Math.min(ix + 1, map.width - 1);
  return lerp(
    lerp(map.values[a], map.values[b], x - ix),
    lerp(map.values[c], map.values[d], x - ix),
    z - iz,
  );
}
export function resampleHeightmap(
  map: Heightmap,
  width: number,
  height: number,
): Heightmap {
  validateHeightmap(map);
  const result = { width, height, values: new Float32Array(0) };
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16_777_216
  )
    throw new Error('Invalid heightmap output dimensions.');
  result.values = new Float32Array(width * height);
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++)
      result.values[z * width + x] = sampleHeightmap(
        map,
        width === 1 ? 0.5 : x / (width - 1),
        height === 1 ? 0.5 : z / (height - 1),
      );
  return result;
}
/** Replace only heights. Terrain topology, paint, assets and placements are preserved. */
export function applyHeightmap(
  project: TerrainProject,
  map: Heightmap,
  minimum: number,
  maximum: number,
  flipZ = false,
) {
  validateHeightmap(map);
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    maximum < minimum ||
    minimum < -project.size ||
    maximum > project.size
  )
    throw new Error(
      'Height range must be ordered and within the terrain size bounds.',
    );
  const n = project.resolution,
    next = new Float32Array((n + 1) ** 2);
  for (let z = 0; z <= n; z++)
    for (let x = 0; x <= n; x++)
      next[z * (n + 1) + x] = lerp(
        minimum,
        maximum,
        sampleHeightmap(map, x / n, flipZ ? 1 - z / n : z / n),
      );
  project.heights = next;
}
export function terrainHeightmap(
  project: TerrainProject,
  minimum: number,
  maximum: number,
): Heightmap {
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    maximum <= minimum
  )
    throw new Error('Export maximum height must exceed minimum height.');
  return {
    width: project.resolution + 1,
    height: project.resolution + 1,
    values: Float32Array.from(project.heights, (h) =>
      clamp((h - minimum) / (maximum - minimum)),
    ),
  };
}
export function decodeRaw16(
  data: ArrayBuffer,
  width: number,
  height = width,
  littleEndian = true,
): Heightmap {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16_777_216 ||
    data.byteLength !== width * height * 2
  )
    throw new Error(
      'RAW16 dimensions must match the file byte length exactly.',
    );
  const view = new DataView(data),
    values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++)
    values[i] = view.getUint16(i * 2, littleEndian) / 65535;
  return { width, height, values };
}
export function encodeRaw16(map: Heightmap, littleEndian = true): ArrayBuffer {
  validateHeightmap(map);
  const data = new ArrayBuffer(map.values.length * 2),
    view = new DataView(data);
  for (let i = 0; i < map.values.length; i++)
    view.setUint16(i * 2, Math.round(map.values[i] * 65535), littleEndian);
  return data;
}
