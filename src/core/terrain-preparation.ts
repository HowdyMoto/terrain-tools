import { buildMeshData, effectiveHoles, heightAt } from './terrain';
import { buildTerrainLods } from './terrain-lod';
import type { TerrainLodLevel } from './terrain-lod';
import type { TerrainProject, TerrainMeshData } from './types';

export interface PreparedTerrainChunk extends TerrainMeshData {
  x: number;
  z: number;
  nx: number;
  nz: number;
  normals: Float32Array;
  bounds: [number, number, number, number, number, number];
  sphere: [number, number, number, number];
  lods?: TerrainLodLevel[];
  lodBounds?: ReturnType<typeof terrainGeometryBounds>[];
}
export function terrainGeometryBounds(
  positions: Float32Array,
  target?: Float32Array,
) {
  const box: PreparedTerrainChunk['bounds'] = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ];
  const arrays = target ? [positions, target] : [positions];
  for (const array of arrays)
    for (let i = 0; i < array.length; i += 3)
      for (let axis = 0; axis < 3; axis++) {
        box[axis] = Math.min(box[axis], array[i + axis]);
        box[axis + 3] = Math.max(box[axis + 3], array[i + axis]);
      }
  const sphere: PreparedTerrainChunk['sphere'] = [
    (box[0] + box[3]) / 2,
    (box[1] + box[4]) / 2,
    (box[2] + box[5]) / 2,
    0,
  ];
  let radius = 0;
  for (const array of arrays)
    for (let i = 0; i < array.length; i += 3) {
      const dx = array[i] - sphere[0],
        dy = array[i + 1] - sphere[1],
        dz = array[i + 2] - sphere[2];
      radius = Math.max(radius, dx * dx + dy * dy + dz * dz);
    }
  sphere[3] = Math.sqrt(radius);
  return { box, sphere };
}
export interface PreparedTerrainData {
  resolution: number;
  size: number;
  chunks: PreparedTerrainChunk[];
}
/** Minimal snapshot: never copy embedded models, HDRs or texture payloads to a
 * terrain worker. These functions only read grid/placement-rule inputs. */
export function terrainPreparationInput(p: TerrainProject): TerrainProject {
  return {
    size: p.size,
    resolution: p.resolution,
    heights: p.heights.slice(),
    paint: p.paint.slice(),
    holes: p.holes.slice(),
    props: structuredClone(p.props),
    materials: p.materials.map((material) => ({ ...material, textures: {} })),
  } as TerrainProject;
}
/** Pure transferable terrain preparation, used both by workers and fallback hosts. */
export function prepareTerrainData(
  p: TerrainProject,
  lod = true,
): PreparedTerrainData {
  const holes = effectiveHoles(p),
    chunks: PreparedTerrainChunk[] = [];
  const spacing = p.size / p.resolution;
  for (let z = 0; z < p.resolution; z += 32)
    for (let x = 0; x < p.resolution; x += 32) {
      const nx = Math.min(32, p.resolution - x),
        nz = Math.min(32, p.resolution - z);
      const data = buildMeshData(p, x, z, nx, nz, holes);
      const normals = new Float32Array(data.positions.length);
      for (let i = 0; i < data.positions.length; i += 3) {
        const px = data.positions[i],
          pz = data.positions[i + 2];
        const dx =
            heightAt(p, px - spacing, pz) - heightAt(p, px + spacing, pz),
          dy = 2 * spacing,
          dz = heightAt(p, px, pz - spacing) - heightAt(p, px, pz + spacing);
        const inverse = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
        normals[i] = dx * inverse;
        normals[i + 1] = dy * inverse;
        normals[i + 2] = dz * inverse;
      }
      const levels = lod
        ? buildTerrainLods(data.positions, data.indices, nx, nz)
        : undefined;
      const bounds = terrainGeometryBounds(data.positions);
      chunks.push({
        x,
        z,
        nx,
        nz,
        ...data,
        normals,
        bounds: bounds.box,
        sphere: bounds.sphere,
        lods: levels,
        lodBounds: levels?.map((level) =>
          terrainGeometryBounds(data.positions, level.target),
        ),
      });
    }
  return { size: p.size, resolution: p.resolution, chunks };
}
export function terrainPreparationTransfers(
  data: PreparedTerrainData,
): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const chunk of data.chunks) {
    for (const array of [
      chunk.positions,
      chunk.weights,
      chunk.indices,
      chunk.normals,
    ])
      buffers.add(array.buffer as ArrayBuffer);
    for (const level of chunk.lods ?? []) {
      buffers.add(level.indices.buffer as ArrayBuffer);
      buffers.add(level.target.buffer as ArrayBuffer);
    }
  }
  return [...buffers];
}
