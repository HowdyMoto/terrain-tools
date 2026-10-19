import { checkTextureDimensions } from '../core/texture-limits';
import type { DecodedTexture } from './texture-decode';

/** Targa 1/2: indexed, true-color and grayscale, raw or RLE. */
export function decodeTga(buffer: ArrayBuffer): DecodedTexture {
  const bytes = new Uint8Array(buffer),
    view = new DataView(buffer);
  const fail = () => {
    throw new Error(
      'Invalid or truncated TGA image. Export it again as TGA or PNG.',
    );
  };
  if (bytes.length < 18) fail();
  const type = bytes[2],
    indexed = type === 1 || type === 9;
  const gray = type === 3 || type === 11,
    rle = type >= 9;
  const width = view.getUint16(12, true),
    height = view.getUint16(14, true);
  checkTextureDimensions(width, height);
  const depth = bytes[16],
    attributes = bytes[17] & 15;
  if (
    ![1, 2, 3, 9, 10, 11].includes(type) ||
    bytes[1] !== (indexed ? 1 : 0) ||
    bytes[17] & 192 ||
    !(indexed || gray ? [8, 16] : [16, 24, 32]).includes(depth)
  )
    throw new Error(
      'Unsupported TGA layout. Use a non-interleaved RGB, RGBA, grayscale or indexed TGA.',
    );
  const paletteStart = view.getUint16(3, true),
    paletteLength = view.getUint16(5, true);
  const colorDepth = indexed ? bytes[7] : depth;
  if (indexed && (!paletteLength || ![15, 16, 24, 32].includes(colorDepth)))
    fail();
  let hasAlpha = gray
    ? depth === 16 && attributes === 8
    : (colorDepth === 32 && attributes === 8) ||
      (colorDepth === 16 && attributes === 1);
  let associated = false,
    end = bytes.length;
  // TGA 2.0's extension can override the old descriptor's alpha semantics.
  if (
    bytes.length >= 26 &&
    new TextDecoder().decode(bytes.subarray(-18)) === 'TRUEVISION-XFILE.\0'
  ) {
    end -= 26;
    const footer = end;
    const extension = view.getUint32(end, true),
      developer = view.getUint32(end + 4, true);
    if (extension) {
      if (
        extension < 18 ||
        extension + 495 > end ||
        view.getUint16(extension, true) < 495
      )
        fail();
      const alphaType = bytes[extension + 494];
      if (alphaType > 4) fail();
      hasAlpha =
        alphaType >= 2 && (gray ? depth === 16 : [16, 32].includes(colorDepth));
      associated = alphaType === 4;
      end = Math.min(end, extension);
    }
    if (developer) {
      if (developer < 18 || developer + 2 > footer) fail();
      end = Math.min(end, developer);
    }
  }
  let cursor = 18 + bytes[0];
  const take = (count: number) => {
    const start = cursor;
    if (cursor + count > end) fail();
    cursor += count;
    return start;
  };
  const readColor = (offset: number, bits: number): number[] => {
    if (bits === 15 || bits === 16) {
      const n = view.getUint16(offset, true);
      return [
        Math.round((((n >> 10) & 31) * 255) / 31),
        Math.round((((n >> 5) & 31) * 255) / 31),
        Math.round(((n & 31) * 255) / 31),
        hasAlpha ? (n & 32768 ? 255 : 0) : 255,
      ];
    }
    return [
      bytes[offset + 2],
      bytes[offset + 1],
      bytes[offset],
      hasAlpha ? bytes[offset + 3] : 255,
    ];
  };
  const palette: number[][] = [];
  if (indexed)
    for (let i = 0; i < paletteLength; i++)
      palette.push(readColor(take(Math.ceil(colorDepth / 8)), colorDepth));
  const pixel = () => {
    const offset = take(depth / 8);
    if (indexed) {
      const index =
        (depth === 8 ? bytes[offset] : view.getUint16(offset, true)) -
        paletteStart;
      if (index < 0 || index >= palette.length) fail();
      return palette[index];
    }
    if (gray)
      return [
        bytes[offset],
        bytes[offset],
        bytes[offset],
        hasAlpha ? bytes[offset + 1] : 255,
      ];
    return readColor(offset, depth);
  };
  const rgba = new Uint8Array(width * height * 4);
  let written = 0;
  const write = (color: number[]) => {
    const x = written % width,
      y = Math.floor(written / width);
    const target =
      ((bytes[17] & 32 ? y : height - 1 - y) * width +
        (bytes[17] & 16 ? width - 1 - x : x)) *
      4;
    for (let c = 0; c < 4; c++)
      rgba[target + c] =
        associated && c < 3
          ? color[3]
            ? Math.min(255, Math.round((color[c] * 255) / color[3]))
            : 0
          : color[c];
    written++;
  };
  while (written < width * height) {
    const packet = rle ? bytes[take(1)] : 0;
    const count = rle ? (packet & 127) + 1 : 1;
    if (written + count > width * height) fail();
    const repeated = packet & 128 ? pixel() : undefined;
    for (let i = 0; i < count; i++) write(repeated ?? pixel());
  }
  return { width, height, rgba, hasAlpha };
}
