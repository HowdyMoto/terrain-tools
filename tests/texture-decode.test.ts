import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  decodeTexture,
  textureChannel,
  textureRgba8,
} from '../src/editor/texture-decode';
import { packOrmMap } from '../src/core/orm';
import { validateTiffBlock } from '../src/editor/tiff-block';
import { deflateSync } from 'node:zlib';
import { tiffFixture, tgaFixture } from './texture-fixtures';

describe('TIFF material decoding', () => {
  for (const littleEndian of [true, false])
    it(`preserves 16-bit samples and transparent RGB (${littleEndian ? 'LE' : 'BE'})`, async () => {
      const image = await decodeTexture(
        tiffFixture({
          bits: 16,
          pixels: [4355, 26214, 12345, 0],
          littleEndian,
        }),
        'Stone_MaskMap.TIFF',
      );
      expect([...image.rgba]).toEqual([4355, 26214, 12345, 0]);
      expect(textureChannel(image, 'red').values[0]).toBeCloseTo(
        4355 / 65535,
        7,
      );
      expect([...textureRgba8(image)]).toEqual([17, 102, 48, 0]);
      expect([
        ...packOrmMap(
          {
            occlusion: textureChannel(image, 'green'),
            metalness: textureChannel(image, 'red'),
            roughness: textureChannel(image, 'alpha', true),
            roughnessIsGloss: true,
          },
          1,
        ),
      ]).toEqual([102, 255, 17, 255]);
    });
  it('keeps low bits until bilinear ORM resizing instead of quantizing each source pixel', async () => {
    const image = await decodeTexture(
      tiffFixture({ width: 2, channels: 1, bits: 16, pixels: [120, 129] }),
      'height.tif',
    );
    expect([
      ...packOrmMap({ roughness: textureChannel(image, 'red') }, 1),
    ]).toEqual([255, 0, 255, 255]);
    const prematurelyRounded = {
      width: 2,
      height: 1,
      values: new Float32Array([0, 1 / 255]),
    };
    expect([...packOrmMap({ roughness: prematurelyRounded }, 1)]).toEqual([
      255, 1, 255, 255,
    ]);
  });
  for (const [orientation, expected] of [
    [1, [10, 20, 30, 40, 50, 60]],
    [2, [30, 20, 10, 60, 50, 40]],
    [3, [60, 50, 40, 30, 20, 10]],
    [4, [40, 50, 60, 10, 20, 30]],
    [5, [10, 40, 20, 50, 30, 60]],
    [6, [40, 10, 50, 20, 60, 30]],
    [7, [60, 30, 50, 20, 40, 10]],
    [8, [30, 60, 20, 50, 10, 40]],
  ] as const) {
    it(`honors TIFF orientation ${orientation}`, async () => {
      const image = await decodeTexture(
        tiffFixture({
          width: 3,
          height: 2,
          channels: 1,
          pixels: [10, 20, 30, 40, 50, 60],
          tags: { 274: [orientation] },
        }),
        'height.tif',
      );
      expect(image.width).toBe(orientation >= 5 ? 2 : 3);
      expect(image.height).toBe(orientation >= 5 ? 3 : 2);
      expect([...image.rgba].filter((_, i) => i % 4 === 0)).toEqual(expected);
    });
  }
  for (const compression of ['none', 'lzw', 'deflate', 'packbits'] as const)
    for (const tile of [false, true]) {
      it(`reads independent libvips ${compression} ${tile ? 'tiles' : 'strips'} with prediction`, async () => {
        const pixels = Uint8Array.from(
          { length: 37 * 29 * 3 },
          (_, i) => (i * i * 29 + i * 17) % 256,
        );
        const encoded = await sharp(pixels, {
          raw: { width: 37, height: 29, channels: 3 },
        })
          .tiff({
            compression,
            predictor:
              compression === 'lzw' || compression === 'deflate'
                ? 'horizontal'
                : 'none',
            tile,
            tileWidth: 16,
            tileHeight: 16,
          })
          .toBuffer();
        const image = await decodeTexture(
          new Uint8Array(encoded).buffer,
          'albedo.tiff',
        );
        expect([...image.rgba].filter((_, i) => i % 4 !== 3)).toEqual([
          ...pixels,
        ]);
      });
    }
  it('handles white-is-zero grayscale and associated alpha explicitly', async () => {
    expect([
      ...(
        await decodeTexture(
          tiffFixture({ channels: 1, pixels: [17], tags: { 262: [0] } }),
          'h.tif',
        )
      ).rgba,
    ]).toEqual([238, 238, 238, 255]);
    expect([
      ...(
        await decodeTexture(
          tiffFixture({ pixels: [64, 32, 16, 128], tags: { 338: [1] } }),
          'a.tif',
        )
      ).rgba,
    ]).toEqual([128, 64, 32, 128]);
    const image = await decodeTexture(
      tiffFixture({ channels: 3, pixels: [17, 102, 153] }),
      'a.tif',
    );
    expect(() => textureChannel(image, 'alpha', true)).toThrow(
      'no alpha channel',
    );
  });
  it('validates LZW dictionary growth and reset against independent noisy RGB data', async () => {
    let seed = 27183;
    const pixels = Uint8Array.from({ length: 128 * 96 * 3 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    });
    const encoded = await sharp(pixels, {
      raw: { width: 128, height: 96, channels: 3 },
    })
      .tiff({ compression: 'lzw', predictor: 'horizontal' })
      .toBuffer();
    const image = await decodeTexture(
      new Uint8Array(encoded).buffer,
      'noise.tif',
    );
    expect([...image.rgba].filter((_, i) => i % 4 !== 3)).toEqual([...pixels]);
  });
  for (const littleEndian of [true, false])
    it(`restores 16-bit horizontal prediction after Deflate (${littleEndian ? 'LE' : 'BE'})`, async () => {
      const values = [40000, 12345, 65535];
      const raw = tiffFixture({
        width: 3,
        channels: 1,
        bits: 16,
        littleEndian,
        pixels: [40000, (12345 - 40000) & 65535, 65535 - 12345],
        tags: { 259: [8], 317: [2] },
      });
      const pixelOffset = raw.byteLength - 6;
      const compressed = deflateSync(new Uint8Array(raw, pixelOffset));
      const bytes = new Uint8Array(pixelOffset + compressed.length);
      bytes.set(new Uint8Array(raw, 0, pixelOffset));
      bytes.set(compressed, pixelOffset);
      const view = new DataView(bytes.buffer),
        count = view.getUint16(8, littleEndian);
      for (let i = 0; i < count; i++) {
        const entry = 10 + i * 12;
        if (view.getUint16(entry, littleEndian) === 279)
          view.setUint32(entry + 8, compressed.length, littleEndian);
      }
      const image = await decodeTexture(bytes.buffer, 'height16.tif');
      expect([...image.rgba].filter((_, i) => i % 4 === 0)).toEqual(values);
    });
  it('rejects corrupt compressed TIFF blocks instead of silently filling pixels with zero', async () => {
    // No LZW end code; missing PackBits literal; valid Deflate of the wrong size.
    for (const [compression, bytes] of [
      [5, new Uint8Array([128, 0, 0])],
      [32773, new Uint8Array([2, 17])],
      [8, new Uint8Array(deflateSync(new Uint8Array(4096)))],
    ] as const)
      await expect(validateTiffBlock(bytes, compression, 4)).rejects.toThrow(
        'truncated TIFF pixel',
      );
    for (const compression of [5, 8, 32773])
      await expect(
        decodeTexture(
          tiffFixture({ tags: { 259: [compression] } }),
          'corrupt.tif',
        ),
      ).rejects.toThrow(/TIFF/);
  });
  it('rejects unsupported numeric formats, truncation and oversized allocation before decoding', async () => {
    for (const tags of [{ 339: [3] }, { 284: [2] }, { 259: [7] }] as Record<
      number,
      number[]
    >[])
      await expect(
        decodeTexture(tiffFixture({ tags }), 'a.tif'),
      ).rejects.toThrow('Unsupported TIFF');
    await expect(
      decodeTexture(tiffFixture().slice(0, -1), 'a.tif'),
    ).rejects.toThrow('truncated TIFF');
    await expect(
      decodeTexture(tiffFixture({ width: 100000, height: 100000 }), 'a.tif'),
    ).rejects.toThrow('16 megapixels');
    const corrupt = tiffFixture();
    new DataView(corrupt).setUint32(4, 0xffffffff, true);
    await expect(decodeTexture(corrupt, 'a.tif')).rejects.toThrow(
      'truncated TIFF',
    );
  });
});

describe('TGA material decoding', () => {
  for (const [descriptor, expected] of [
    [32, [10, 20, 30, 40]],
    [0, [30, 40, 10, 20]],
    [48, [20, 10, 40, 30]],
    [16, [40, 30, 20, 10]],
  ] as const) {
    it(`normalizes TGA origin bits ${descriptor}`, async () => {
      const image = await decodeTexture(
        tgaFixture({
          width: 2,
          height: 2,
          type: 3,
          bits: 8,
          descriptor,
          pixels: [10, 20, 30, 40],
        }),
        'height.TGA',
      );
      expect([...image.rgba].filter((_, i) => i % 4 === 0)).toEqual(expected);
    });
  }
  it('preserves RGB under zero alpha and reads both kinds of RLE packet', async () => {
    const image = await decodeTexture(
      tgaFixture({
        width: 4,
        type: 10,
        pixels: [129, 153, 102, 17, 0, 1, 30, 20, 10, 255, 60, 50, 40, 128],
      }),
      'mask.tga',
    );
    expect([...image.rgba]).toEqual([
      17, 102, 153, 0, 17, 102, 153, 0, 10, 20, 30, 255, 40, 50, 60, 128,
    ]);
    expect(textureChannel(image, 'alpha', true).values[0]).toBe(0);
  });
  it('reads 16-bit RGB, 16-bit grayscale+alpha, and an offset color palette', async () => {
    expect([
      ...(
        await decodeTexture(
          tgaFixture({ bits: 16, descriptor: 33, pixels: [0, 252] }),
          'a.tga',
        )
      ).rgba,
    ]).toEqual([255, 0, 0, 255]);
    expect([
      ...(
        await decodeTexture(
          tgaFixture({ type: 3, bits: 16, pixels: [40, 77] }),
          'a.tga',
        )
      ).rgba,
    ]).toEqual([40, 40, 40, 77]);
    expect([
      ...(
        await decodeTexture(
          tgaFixture({
            type: 1,
            bits: 8,
            descriptor: 32,
            palette: [10, 20, 30],
            paletteStart: 5,
            pixels: [5],
          }),
          'a.tga',
        )
      ).rgba,
    ]).toEqual([30, 20, 10, 255]);
    const noAlpha = await decodeTexture(
      tgaFixture({ bits: 24, descriptor: 32, pixels: [1, 2, 3] }),
      'a.tga',
    );
    expect(() => textureChannel(noAlpha, 'alpha', true)).toThrow(
      'no alpha channel',
    );
  });
  it('rejects truncated pixels/RLE, overflowing runs, invalid palettes and dimensions', async () => {
    for (const fixture of [
      tgaFixture().slice(0, -1),
      tgaFixture({ type: 10, pixels: [128, 1] }),
      tgaFixture({ type: 10, pixels: [129, 1, 2, 3, 4] }),
      tgaFixture({ type: 1, bits: 8, palette: [1, 2, 3], pixels: [2] }),
    ])
      await expect(decodeTexture(fixture, 'a.tga')).rejects.toThrow(
        'truncated TGA',
      );
    await expect(
      decodeTexture(tgaFixture({ width: 65535, height: 65535 }), 'a.tga'),
    ).rejects.toThrow('16 megapixels');
  });
  it('honors TGA 2 alpha metadata even with a developer area after the extension', async () => {
    const original = tgaFixture({ descriptor: 32, pixels: [16, 32, 64, 128] });
    const bytes = new Uint8Array(original.byteLength + 495 + 2 + 26),
      view = new DataView(bytes.buffer);
    bytes.set(new Uint8Array(original));
    const extension = original.byteLength,
      footer = bytes.length - 26;
    view.setUint16(extension, 495, true);
    bytes[extension + 494] = 4; // Premultiplied alpha overrides descriptor 0.
    view.setUint32(footer, extension, true);
    view.setUint32(footer + 4, extension + 495, true);
    bytes.set(new TextEncoder().encode('TRUEVISION-XFILE.\0'), footer + 8);
    const image = await decodeTexture(bytes.buffer, 'albedo.tga');
    expect(image.hasAlpha).toBe(true);
    expect([...image.rgba]).toEqual([128, 64, 32, 128]);
  });
});
