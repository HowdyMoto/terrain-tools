export interface TerrainLodLevel {
  indices: Uint32Array;
  /** Absolute positions for morphing to the next coarser level; boundary vertices stay fixed. */
  target: Float32Array;
  /** Maximum sampled vertical error against the full-resolution vertex grid, in metres. */
  error: number;
}

interface Topology {
  indices: Uint32Array;
  vertices: Uint16Array;
  weights: Float64Array;
}
// Grid triangle lookup is independent of heights. Keep at most eight dimension
// pairs (under 2 MiB of typed buffers even for eight maximum-size entries).
// Never expose cached arrays: callers own their returned indices/morph targets.
const topologyCache = new Map<string, Topology[]>();
function terrainLodTopologies(nx: number, nz: number) {
  const key = nx + ',' + nz;
  const cached = topologyCache.get(key);
  if (cached) {
    topologyCache.delete(key);
    topologyCache.set(key, cached);
    return cached;
  }
  const side = nx + 1;
  const topologies: Topology[] = [];
  for (let step = 2; step <= Math.min(nx, nz); step *= 2) {
    if (nx % step || nz % step) break;
    const indices: number[] = [],
      buckets: number[][] = [];
    const id = (x: number, z: number) => z * side + x;
    for (let z = 0; z < nz; z += step)
      for (let x = 0; x < nx; x += step) {
        const bucket: number[] = [];
        const triangle = (a: number, b: number, c: number) => {
          indices.push(a, b, c);
          bucket.push(a, b, c);
        };
        if (x > 0 && z > 0 && x + step < nx && z + step < nz) {
          triangle(id(x, z), id(x, z + step), id(x + step, z));
          triangle(id(x + step, z), id(x, z + step), id(x + step, z + step));
        } else {
          const border: number[] = [];
          for (let i = 0; i < step; i += z === 0 ? 1 : step)
            border.push(id(x + i, z));
          for (let i = 0; i < step; i += x + step === nx ? 1 : step)
            border.push(id(x + step, z + i));
          for (let i = 0; i < step; i += z + step === nz ? 1 : step)
            border.push(id(x + step - i, z + step));
          for (let i = 0; i < step; i += x === 0 ? 1 : step)
            border.push(id(x, z + step - i));
          const center = id(x + step / 2, z + step / 2);
          for (let i = 0; i < border.length; i++)
            triangle(center, border[(i + 1) % border.length], border[i]);
        }
        buckets.push(bucket);
      }
    const vertices = new Uint16Array((nx + 1) * (nz + 1) * 3),
      weights = new Float64Array(vertices.length);
    const locate = (x: number, z: number) => {
      const bx = Math.min(nx / step - 1, Math.floor(x / step)),
        bz = Math.min(nz / step - 1, Math.floor(z / step));
      const triangle = buckets[bz * (nx / step) + bx];
      for (let i = 0; i < triangle.length; i += 3) {
        const a = triangle[i],
          b = triangle[i + 1],
          c = triangle[i + 2];
        const ax = a % side,
          az = Math.floor(a / side),
          bx = b % side,
          bz = Math.floor(b / side),
          cx = c % side,
          cz = Math.floor(c / side);
        const divisor = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / divisor;
        const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / divisor,
          w = 1 - u - v;
        if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) {
          const offset = (z * side + x) * 3;
          vertices.set([a, b, c], offset);
          weights.set([u, v, w], offset);
          return;
        }
      }
      throw new Error('LOD topology does not cover its heightfield.');
    };
    for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++) locate(x, z);
    topologies.push({ indices: new Uint32Array(indices), vertices, weights });
  }
  topologyCache.set(key, topologies);
  if (topologyCache.size > 8)
    topologyCache.delete(topologyCache.keys().next().value!);
  return topologies;
}

/** Indexed heightfield LOD retaining every boundary vertex at every level.
 * The full-resolution vertex/normal/weight buffers are shared; only submitted
 * triangles change. Chunks containing holes retain their authoritative topology.
 * Cached grid interpolation tables are bounded; returned arrays remain independent.
 */
export function buildTerrainLods(
  positions: Float32Array,
  original: Uint32Array,
  nx: number,
  nz: number,
): TerrainLodLevel[] {
  if (
    nx < 1 ||
    nz < 1 ||
    nx > 32 ||
    nz > 32 ||
    !Number.isInteger(nx) ||
    !Number.isInteger(nz) ||
    positions.length !== (nx + 1) * (nz + 1) * 3
  )
    throw new Error(
      'LOD requires a heightfield chunk of at most 32 cells per side.',
    );
  const topologies =
    original.length === nx * nz * 6 ? terrainLodTopologies(nx, nz) : [];
  const count = (nx + 1) * (nz + 1);
  const primary = Float64Array.from(
    { length: count },
    (_, i) => positions[i * 3 + 1],
  );
  const samples = [
    primary,
    ...topologies.map(({ vertices, weights }) => {
      const heights = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        const offset = i * 3;
        heights[i] =
          weights[offset] * positions[vertices[offset] * 3 + 1] +
          weights[offset + 1] * positions[vertices[offset + 1] * 3 + 1] +
          weights[offset + 2] * positions[vertices[offset + 2] * 3 + 1];
      }
      return heights;
    }),
  ];
  return samples.map((heights, level) => {
    const target = positions.slice(),
      next = samples[Math.min(level + 1, samples.length - 1)];
    let error = 0;
    for (let i = 0; i < count; i++) {
      error = Math.max(error, Math.abs(positions[i * 3 + 1] - heights[i]));
      target[i * 3 + 1] = next[i];
    }
    return {
      indices: level === 0 ? original : topologies[level - 1].indices.slice(),
      target,
      error,
    };
  });
}
