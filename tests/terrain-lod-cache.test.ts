import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTerrainLods } from '../src/core/terrain-lod';

function grid(nx: number, nz: number, offset = 0) {
  const positions = new Float32Array((nx + 1) * (nz + 1) * 3);
  const indices: number[] = [];
  for (let z = 0; z <= nz; z++)
    for (let x = 0; x <= nx; x++) {
      const i = z * (nx + 1) + x;
      positions.set(
        [
          x * 1.25,
          (((i * 17) % 83) - 41) * 0.125 + ((x * z) % 7) * 0.0625 + offset,
          z * 2.5,
        ],
        i * 3,
      );
    }
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const a = z * (nx + 1) + x,
        b = a + nx + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions, indices: new Uint32Array(indices) };
}
function signature(levels: ReturnType<typeof buildTerrainLods>) {
  const hash = createHash('sha256');
  for (const level of levels) {
    hash.update(
      new Uint8Array(
        level.indices.buffer,
        level.indices.byteOffset,
        level.indices.byteLength,
      ),
    );
    hash.update(
      new Uint8Array(
        level.target.buffer,
        level.target.byteOffset,
        level.target.byteLength,
      ),
    );
    hash.update(new Uint8Array(new Float64Array([level.error]).buffer));
  }
  return hash.digest('hex');
}

describe('cached terrain LOD topology', () => {
  // Captured from the uncached triangle-search implementation, before this change.
  it.each([
    [
      32,
      32,
      '2a213ead6bb04e5b2b3c2f1f90cd8a0b1d242611bef1ce5c45d10179f4b9a3a7',
    ],
    [16, 8, '88cab46917043ce7db539870f433d1d105dce4ebfeb328a7b8d5e54587d98159'],
    [
      12,
      16,
      '792f9599a97ccb9c147e6721ca3da935dcffba25c4258c08e5e4ef87cda9c945',
    ],
    [1, 5, 'dc2d54db693a926318a2cfe88ea5ef9c61ce8f8d63d2c72ba9a50ba51e032dc8'],
    [
      31,
      32,
      'c21ecebccb85d506e6fa14103945e8233fa9d14a2a87039452b9f94e7a29e7d3',
    ],
  ] as const)(
    'preserves exact indices, morph positions and errors for %i × %i grids',
    (nx, nz, expected) => {
      const data = grid(nx, nz);
      for (let repeat = 0; repeat < 2; repeat++)
        expect(
          signature(buildTerrainLods(data.positions, data.indices, nx, nz)),
        ).toBe(expected);
    },
  );

  it('keeps returned arrays private and samples each tile’s own heights after eviction', () => {
    const a = grid(32, 32),
      b = grid(32, 32, 7.125);
    const before = a.positions.slice();
    const first = buildTerrainLods(a.positions, a.indices, 32, 32);
    const expected = signature(first);
    const shifted = buildTerrainLods(b.positions, b.indices, 32, 32);
    shifted.forEach((level, index) => {
      expect(level.error).toBe(first[index].error);
      for (let i = 1; i < level.target.length; i += 3)
        expect(level.target[i]).toBe(first[index].target[i] + 7.125);
    });
    for (let i = 0; i < first.length; i++) {
      first[i].target.fill(999);
      if (i > 0) first[i].indices.fill(0);
    }
    expect(signature(buildTerrainLods(a.positions, a.indices, 32, 32))).toBe(
      expected,
    );
    for (let size = 2; size < 12; size++) {
      const other = grid(size, size);
      buildTerrainLods(other.positions, other.indices, size, size);
    }
    expect(signature(buildTerrainLods(a.positions, a.indices, 32, 32))).toBe(
      expected,
    );
    expect(a.positions).toEqual(before);
  });

  it('retains authoritative holes even after warming the same full-grid dimensions', () => {
    const data = grid(32, 32);
    buildTerrainLods(data.positions, data.indices, 32, 32);
    const holes = data.indices.slice(6);
    const levels = buildTerrainLods(data.positions, holes, 32, 32);
    expect(levels).toHaveLength(1);
    expect(levels[0].indices).toBe(holes);
    expect(levels[0].target).toEqual(data.positions);
    expect(levels[0].target).not.toBe(data.positions);
    expect(levels[0].error).toBe(0);
  });
});
