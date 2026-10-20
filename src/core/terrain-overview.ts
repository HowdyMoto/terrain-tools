import type { TerrainProject, TerrainMeshData } from './types';
import {
  buildMeshData,
  effectiveHoles,
  heightAt,
  materialWeights,
} from './terrain';

/** Compact visual terrain, retaining every authoritative outer-edge sample.
 * Boundary fans meet detailed tiles without skirts, overlap or T-junction gaps.
 * Holes/cutouts conservatively keep their full topology. No collision is built. */
export function buildTerrainOverview(
  p: TerrainProject,
  step = Math.max(2, p.resolution / 16),
  maxBytes = Infinity,
): TerrainMeshData & { normals: Float32Array } {
  const n = p.resolution;
  if (
    !Number.isFinite(p.size) ||
    p.size <= 0 ||
    !Number.isInteger(n) ||
    n < 2 ||
    n > 2048 ||
    p.heights.length !== (n + 1) ** 2 ||
    p.paint.length !== (n + 1) ** 2 * 4 ||
    p.holes.length !== n * n ||
    !Number.isInteger(step) ||
    step < 2 ||
    step % 2 ||
    n % step
  )
    throw new Error('Invalid terrain overview grid or step.');
  for (const h of p.heights)
    if (!Number.isFinite(h)) throw new Error('Invalid overview height.');
  const holes = effectiveHoles(p);
  if (holes.some(Boolean) && (n + 1) ** 2 * 40 + n * n * 24 > maxBytes)
    throw new Error(
      'Overview holes require full topology exceeding the geometry budget.',
    );
  const positions: number[] = [],
    normals: number[] = [],
    weights: number[] = [],
    indices: number[] = [];
  const vertices = new Map<number, number>();
  const spacing = p.size / n;
  const vertex = (x: number, z: number) => {
    const key = z * (n + 1) + x;
    const existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3,
      px = x * spacing - p.size / 2,
      pz = z * spacing - p.size / 2;
    positions.push(px, p.heights[key], pz);
    const nx = heightAt(p, px - spacing, pz) - heightAt(p, px + spacing, pz),
      ny = 2 * spacing,
      nz = heightAt(p, px, pz - spacing) - heightAt(p, px, pz + spacing),
      length = Math.hypot(nx, ny, nz);
    normals.push(nx / length, ny / length, nz / length);
    weights.push(...materialWeights(p, px, pz));
    vertices.set(key, index);
    return index;
  };
  if (holes.some(Boolean)) {
    const full = buildMeshData(p, 0, 0, n, n, holes);
    for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) vertex(x, z);
    return { ...full, normals: new Float32Array(normals) };
  }
  for (let z = 0; z < n; z += step)
    for (let x = 0; x < n; x += step) {
      if (x > 0 && z > 0 && x + step < n && z + step < n) {
        const a = vertex(x, z),
          b = vertex(x + step, z),
          c = vertex(x, z + step),
          d = vertex(x + step, z + step);
        indices.push(a, c, b, b, c, d);
      } else {
        const border: number[] = [];
        for (let i = 0; i < step; i += z === 0 ? 1 : step)
          border.push(vertex(x + i, z));
        for (let i = 0; i < step; i += x + step === n ? 1 : step)
          border.push(vertex(x + step, z + i));
        for (let i = 0; i < step; i += z + step === n ? 1 : step)
          border.push(vertex(x + step - i, z + step));
        for (let i = 0; i < step; i += x === 0 ? 1 : step)
          border.push(vertex(x, z + step - i));
        const center = vertex(x + step / 2, z + step / 2);
        for (let i = 0; i < border.length; i++)
          indices.push(center, border[(i + 1) % border.length], border[i]);
      }
    }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    weights: new Float32Array(weights),
    indices: new Uint32Array(indices),
  };
}
