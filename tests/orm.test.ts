import { describe, expect, it } from 'vitest';
import {
  packOrmMap,
  encodeRgbaPNG,
  decodeHeightmapPNG,
  createProject,
  serializeProject,
  parseProject,
  serializeProjectPackage,
  parseProjectPackage,
  defaultSculptSettings,
} from '../src/index';
import type { PNGChannel } from '../src/core/heightmap-png';
import type { Heightmap } from '../src/core/heightmap';

const map = (
  values: number[],
  width = values.length,
  height = 1,
): Heightmap => ({ width, height, values: new Float32Array(values) });
// Independently encoded RGBA16 PNG: [0,1000,65535,32768], [256,65535,7,65535].
function rgba16() {
  return Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAYAAACksqPJAAAAGklEQVR4nGNgYGB+8f9/AwMjw///DOz//wMANfsHbkZmLm4AAAAASUVORK5CYII=',
    ),
    (c) => c.charCodeAt(0),
  ).buffer;
}
describe('PBR channel authoring', () => {
  it('packs resampled linear channels, preserves source data, and inverts gloss only when supplied', () => {
    const sources = {
      occlusion: map([0, 1]),
      roughness: map([0.2]),
      metalness: map([0, 0.5, 1]),
      roughnessIsGloss: true,
    };
    const before = structuredClone(sources);
    const packed = packOrmMap(sources, 3, 1);
    expect(Array.from(packed)).toEqual([
      0, 204, 0, 255, 128, 204, 128, 255, 255, 204, 255, 255,
    ]);
    expect(sources).toEqual(before);
    expect(Array.from(packOrmMap({ roughnessIsGloss: true }, 1))).toEqual([
      255, 255, 255, 255,
    ]);
    expect(Array.from(packOrmMap({ occlusion: map([0, 1]) }, 1))).toEqual([
      128, 255, 255, 255,
    ]);
  });
  it('preserves selected 16-bit PNG channels until the final ORM quantization', async () => {
    const bytes = rgba16();
    const red = await decodeHeightmapPNG(bytes, false, 'red');
    const green = await decodeHeightmapPNG(bytes, false, 'green');
    const blue = await decodeHeightmapPNG(bytes, false, 'blue');
    const alpha = await decodeHeightmapPNG(bytes, true, 'alpha');
    expect(red.values[1]).toBeCloseTo(256 / 65535, 9);
    expect(green.values[0]).toBeCloseTo(1000 / 65535, 8);
    expect(blue.values[1]).toBeCloseTo(7 / 65535, 9);
    expect(alpha.values[0]).toBeCloseTo(32768 / 65535, 7);
    expect(
      (await decodeHeightmapPNG(bytes, true, 'green')).values[0],
    ).toBeCloseTo((1000 / 65535) * (32768 / 65535), 8);
    expect(packOrmMap({ roughness: red }, 3, 1)[5]).toBe(0); // Premature 8-bit conversion would yield 1.
    expect((await decodeHeightmapPNG(bytes)).values[0]).toBeCloseTo(
      (1000 * 0.7152 + 65535 * 0.0722) / 65535,
      7,
    );
  });
  it('round-trips numeric RGBA channels without color-space or alpha cross-talk', async () => {
    const bytes = new Uint8Array([
      0, 128, 255, 32, 255, 17, 4, 240, 42, 210, 78, 0, 7, 3, 199, 255,
    ]);
    const png = await encodeRgbaPNG(2, 2, bytes);
    for (const [index, channel] of [
      'red',
      'green',
      'blue',
      'alpha',
    ].entries()) {
      const decoded = await decodeHeightmapPNG(
        png,
        false,
        channel as PNGChannel,
      );
      decoded.values.forEach((value, i) =>
        expect(value).toBeCloseTo(bytes[i * 4 + index] / 255, 7),
      );
    }
    const source = map([0, 0.5, 1, 0.25], 2, 2);
    const packed = packOrmMap(
      { occlusion: source, roughness: source, metalness: source },
      2,
    );
    expect(
      (
        await decodeHeightmapPNG(
          await encodeRgbaPNG(2, 2, packed),
          false,
          'green',
        )
      ).values[1],
    ).toBeCloseTo(128 / 255, 7);
  });
  it('rejects malformed channel selections, dimensions and samples', async () => {
    await expect(
      decodeHeightmapPNG(rgba16(), false, 'unknown' as PNGChannel),
    ).rejects.toThrow('channel');
    for (const size of [0, 2049, 1.5, NaN])
      expect(() => packOrmMap({}, size)).toThrow('dimensions');
    expect(() => packOrmMap({ roughness: map([NaN]) }, 1)).toThrow();
    expect(() => packOrmMap({ roughnessIsGloss: 'yes' as never }, 1)).toThrow(
      'gloss',
    );
    await expect(encodeRgbaPNG(2, 2, new Uint8Array(4))).rejects.toThrow(
      'pixels',
    );
    await expect(encodeRgbaPNG(4096, 4096, new Uint8Array())).rejects.toThrow();
  });
  it('persists normal conventions and generated maps through JSON and native projects with legacy defaults', async () => {
    const project = createProject(8, 16);
    project.sculpt = defaultSculptSettings();
    project.materials[0].normalConvention = 'directx';
    const png = await encodeRgbaPNG(
      2,
      2,
      packOrmMap({ roughness: map([0.1, 0.9]) }, 2),
    );
    project.materials[0].textures.orm =
      'data:image/png;base64,' +
      btoa(String.fromCharCode(...new Uint8Array(png)));
    expect(parseProject(serializeProject(project))).toEqual(project);
    expect(
      parseProjectPackage(await serializeProjectPackage(project).arrayBuffer()),
    ).toEqual(project);
    delete project.materials[0].normalConvention;
    expect(
      parseProject(serializeProject(project)).materials[0].normalConvention,
    ).toBeUndefined();
    const invalid = JSON.parse(serializeProject(project));
    for (const convention of [null, 0, 'unknown']) {
      invalid.materials[0].normalConvention = convention;
      expect(() => parseProject(JSON.stringify(invalid))).toThrow('convention');
    }
  });
});
