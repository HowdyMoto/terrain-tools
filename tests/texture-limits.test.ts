import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { checkTextureFile } from '../src/editor/texture-file';
import {
  checkTextureFileSize,
  checkTextureDimensions,
  MAX_TEXTURE_FILE_BYTES,
} from '../src/core/texture-limits';
import { createProject } from '../src/core/terrain';
import {
  assertProjectCapacity,
  parseProjectPackage,
  serializeProjectPackage,
} from '../src/core/project-package';
import { validateProjectData } from '../src/core/serialization';
import { encodeRgbaPNG, decodeHeightmapPNG } from '../src/core/heightmap-png';

describe('material image admission', () => {
  it('admits raw 4K RGBA8/RGBA16 plus headers and rejects excessive files or decoded pixels independently', async () => {
    expect(() => checkTextureFileSize(4096 ** 2 * 4 + 18)).not.toThrow();
    expect(() => checkTextureFileSize(4096 ** 2 * 8 + 4096)).not.toThrow();
    expect(() => checkTextureFileSize(MAX_TEXTURE_FILE_BYTES)).not.toThrow();
    expect(() => checkTextureFileSize(MAX_TEXTURE_FILE_BYTES + 1)).toThrow(
      '256 MiB',
    );
    expect(() => checkTextureDimensions(4096, 4096)).not.toThrow();
    expect(() => checkTextureDimensions(8192, 2048)).not.toThrow();
    expect(() => checkTextureDimensions(4096, 4097)).toThrow('16 megapixels');
    const large = new File([], 'large.tga');
    Object.defineProperty(large, 'size', { value: MAX_TEXTURE_FILE_BYTES + 1 });
    await expect(checkTextureFile(large)).rejects.toThrow('256 MiB');
  });

  for (const format of [
    'png',
    'jpeg',
    'progressive',
    'webp',
    'lossless',
    'extended',
  ] as const) {
    it(`reads ${format} dimensions from independent image bytes without decoding pixels`, async () => {
      const source = sharp({
        create: {
          width: 23,
          height: 11,
          channels: format === 'extended' ? 4 : 3,
          background: { r: 100, g: 80, b: 20, alpha: 0.5 },
        },
      });
      const encoded =
        format === 'png'
          ? await source.png().toBuffer()
          : format === 'jpeg' || format === 'progressive'
            ? await source
                .jpeg({ progressive: format === 'progressive' })
                .toBuffer()
            : await source.webp({ lossless: format === 'lossless' }).toBuffer();
      const extension =
        format === 'png'
          ? 'png'
          : format === 'jpeg' || format === 'progressive'
            ? 'jpg'
            : 'webp';
      const file = new File([new Uint8Array(encoded)], 'map.' + extension);
      await expect(checkTextureFile(file)).resolves.toBeUndefined();
      await expect(
        checkTextureFile(
          new File([new Uint8Array(encoded.subarray(0, 13))], file.name),
        ),
      ).rejects.toThrow('dimensions');
    });
  }

  it('rejects compressed PNG/JPEG/WebP declaring oversized images before browser allocation', async () => {
    const png = Buffer.alloc(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(8192, 16);
    png.writeUInt32BE(8192, 20);
    const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 32, 0, 32, 0, 0]);
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0);
    webp.writeUInt32LE(22, 4);
    webp.write('WEBPVP8X', 8);
    webp.writeUInt32LE(10, 16);
    webp.writeUIntLE(8191, 24, 3);
    webp.writeUIntLE(8191, 27, 3);
    for (const [extension, bytes] of [
      ['png', png],
      ['jpg', jpeg],
      ['webp', webp],
    ] as const)
      await expect(
        checkTextureFile(
          new File([new Uint8Array(bytes)], 'large.' + extension),
        ),
      ).rejects.toThrow('16 megapixels');
  });

  it('checks cancellation before reading metadata', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      checkTextureFile(new File([], 'image.png'), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('large embedded textures', () => {
  it('converts source images wider than the render texture resolution without losing channels', async () => {
    const rgba = Uint8Array.from({ length: 4096 * 4 }, (_, i) => i % 256);
    const png = await encodeRgbaPNG(4096, 1, rgba);
    const red = await decodeHeightmapPNG(png, false, 'red');
    expect([red.width, red.height]).toEqual([4096, 1]);
    expect(Math.round(red.values[4095] * 255)).toBe(rgba[4095 * 4]);
    await expect(encodeRgbaPNG(8192, 8192, new Uint8Array())).rejects.toThrow(
      'dimensions',
    );
  });
  it('round-trips an embedded texture beyond the former serialized-texture ceiling and still applies the project asset budget', async () => {
    const project = createProject(8, 16);
    // Schema fixture, not an image decoder test. Exceeds both former limits:
    // 28M base64 characters in the schema and 32 MB per native package chunk.
    const bytes = 33 * 1024 * 1024;
    project.materials[0].textures.albedo =
      'data:image/png;base64,' + 'AAAA'.repeat(bytes / 3);
    expect(() => validateProjectData(project)).not.toThrow();
    expect(assertProjectCapacity(project)).toBe(bytes);
    expect(() => assertProjectCapacity(project, bytes - 1)).toThrow(
      'package budget',
    );
    const loaded = parseProjectPackage(
      await serializeProjectPackage(project).arrayBuffer(),
    );
    expect(loaded.materials[0].textures.albedo).toBe(
      project.materials[0].textures.albedo,
    );
    project.assets.large = {
      name: 'large.glb',
      data: project.materials[0].textures.albedo!.replace(
        'image/png',
        'model/gltf-binary',
      ),
    };
    delete project.materials[0].textures.albedo;
    expect(() => serializeProjectPackage(project)).toThrow('Models must');
  });
});
