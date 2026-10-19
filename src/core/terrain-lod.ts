export interface TerrainLodLevel {
  indices: Uint32Array;
  /** Absolute positions for morphing to the next coarser level; boundary vertices stay fixed. */
  target: Float32Array;
  /** Maximum sampled vertical error against the full-resolution vertex grid, in metres. */
  error: number;
}

/** Indexed heightfield LOD retaining every boundary vertex at every level.
 * The full-resolution vertex/normal/weight buffers are shared; only submitted
 * triangles change. Chunks containing holes retain their authoritative topology.
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
  const side = nx + 1;
  const topologies = [
    {
      indices: original,
      sample: (x: number, z: number) => positions[(z * side + x) * 3 + 1],
    },
  ];
  if (original.length === nx * nz * 6)
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
      const sample = (x: number, z: number) => {
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
          if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6)
            return (
              u * positions[a * 3 + 1] +
              v * positions[b * 3 + 1] +
              w * positions[c * 3 + 1]
            );
        }
        throw new Error('LOD topology does not cover its heightfield.');
      };
      topologies.push({ indices: new Uint32Array(indices), sample });
    }
  return topologies.map((topology, level) => {
    const target = positions.slice(),
      next = topologies[Math.min(level + 1, topologies.length - 1)];
    let error = 0;
    for (let z = 0; z <= nz; z++)
      for (let x = 0; x <= nx; x++) {
        const y = (z * side + x) * 3 + 1;
        error = Math.max(error, Math.abs(positions[y] - topology.sample(x, z)));
        target[y] = next.sample(x, z);
      }
    return { indices: topology.indices, target, error };
  });
}
