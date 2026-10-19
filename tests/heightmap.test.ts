import { describe, it, expect } from 'vitest';
import {
  applyHeightmap,
  decodeRaw16,
  encodeRaw16,
  terrainHeightmap,
  resampleHeightmap,
} from '../src/core/heightmap';
import {
  decodeHeightmapPNG,
  encodeHeightmapPNG,
} from '../src/core/heightmap-png';
import { createProject } from '../src/core/terrain';
import fixtures from './fixtures/heightmaps.json';
const bytes = (base64: string) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;

describe('precise heightmap exchange', () => {
  it('decodes independent PNG16 fixtures using every scanline filter without losing low bits', async () => {
    const map = await decodeHeightmapPNG(bytes(fixtures.filters));
    expect([map.width, map.height]).toEqual([3, 5]);
    const expected = [
      0, 1, 256, 65535, 32768, 32769, 10, 20, 30, 4095, 4096, 4097, 500, 501,
      502,
    ];
    for (let i = 0; i < expected.length; i++)
      expect(map.values[i] * 65535).toBeCloseTo(expected[i], 2);
    expect(map.values[1]).toBeGreaterThan(0);
    expect(map.values[7]).not.toBe(map.values[8]);
  });
  it('supports packed grayscale, palettes, and optional opacity for sculpt alphas', async () => {
    expect(
      Array.from((await decodeHeightmapPNG(bytes(fixtures.gray1))).values),
    ).toEqual([1, 0, 1]);
    const palette = await decodeHeightmapPNG(bytes(fixtures.palette), true);
    expect(palette.values[1]).toBeCloseTo(0.2126);
    expect(palette.values[2]).toBeCloseTo((0.7152 * 128) / 255);
    expect(palette.values[3]).toBe(0);
    expect((await decodeHeightmapPNG(bytes(fixtures.rgba))).values[0]).toBe(1);
    expect(
      (await decodeHeightmapPNG(bytes(fixtures.rgba), true)).values[0],
    ).toBeCloseTo(128 / 255);
  });
  it('exports grayscale PNG16 and round-trips elevations within half a quantization step', async () => {
    const p = createProject(16, 32),
      minimum = -32,
      maximum = 32;
    const encoded = await encodeHeightmapPNG(
      terrainHeightmap(p, minimum, maximum),
    );
    expect(new Uint8Array(encoded)[24]).toBe(16);
    expect(new Uint8Array(encoded)[25]).toBe(0);
    const map = await decodeHeightmapPNG(encoded),
      copy = structuredClone(p);
    applyHeightmap(copy, map, minimum, maximum);
    for (let i = 0; i < p.heights.length; i++)
      expect(Math.abs(copy.heights[i] - p.heights[i])).toBeLessThan(
        64 / 65535 / 2 + 0.000005,
      );
  });
  it('reads and writes RAW16 with explicit dimensions and byte order', () => {
    const map = {
      width: 2,
      height: 2,
      values: new Float32Array([0, 1 / 65535, 256 / 65535, 1]),
    };
    expect(Array.from(new Uint8Array(encodeRaw16(map, true)))).toEqual([
      0, 0, 1, 0, 0, 1, 255, 255,
    ]);
    expect(Array.from(new Uint8Array(encodeRaw16(map, false)))).toEqual([
      0, 0, 0, 1, 1, 0, 255, 255,
    ]);
    expect(decodeRaw16(encodeRaw16(map, false), 2, 2, false)).toEqual(map);
    expect(() => decodeRaw16(new ArrayBuffer(8), 3, 3)).toThrow('dimensions');
  });
  it('resamples endpoints and flips rows while preserving scene data', () => {
    const p = createProject(8, 16),
      holes = p.holes,
      paint = p.paint,
      brushes = p.brushes;
    const map = {
      width: 2,
      height: 2,
      values: new Float32Array([0, 0.25, 0.75, 1]),
    };
    applyHeightmap(p, map, -8, 8, true);
    expect(p.heights[0]).toBe(4);
    expect(p.heights[8]).toBe(8);
    expect(p.heights[72]).toBe(-8);
    expect(p.heights[80]).toBe(-4);
    expect(p.heights[40]).toBe(0);
    expect(p.holes).toBe(holes);
    expect(p.paint).toBe(paint);
    expect(p.brushes).toBe(brushes);
    expect(resampleHeightmap(map, 1, 1).values[0]).toBe(0.5);
    const before = p.heights.slice();
    expect(() => applyHeightmap(p, map, 20, -20)).toThrow('range');
    expect(p.heights).toEqual(before);
  });
  it('rejects corrupt, interlaced, and oversized decompressed PNG data', async () => {
    const invalid = bytes(fixtures.filters);
    new Uint8Array(invalid)[30] ^= 1;
    await expect(decodeHeightmapPNG(invalid)).rejects.toThrow('checksum');
    await expect(
      decodeHeightmapPNG(bytes(fixtures.interlaced)),
    ).rejects.toThrow('non-interlaced');
    await expect(decodeHeightmapPNG(bytes(fixtures.expansion))).rejects.toThrow(
      'expands',
    );
    await expect(decodeHeightmapPNG(bytes(fixtures.truncated))).rejects.toThrow(
      'truncated',
    );
    await expect(decodeHeightmapPNG(new ArrayBuffer(8))).rejects.toThrow(
      'signature',
    );
  });
});
