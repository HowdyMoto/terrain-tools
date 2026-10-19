import UTIF from 'three/addons/libs/utif.module.js';
import type { TiffImage } from 'three/addons/libs/utif.module.js';
import { checkTextureDimensions } from '../core/texture-limits';
import type { DecodedTexture } from './texture-decode';
import { validateTiffBlock } from './tiff-block';

/** Decode the first classic TIFF image. Only material-safe numeric layouts pass
 * preflight; arbitrary metadata/sub-IFDs never reach UTIF's recursive parser. */
export async function decodeTiff(buffer: ArrayBuffer): Promise<DecodedTexture> {
  const view = new DataView(buffer);
  const invalid = () => {
    throw new Error(
      'Invalid or truncated TIFF image. Export it again as TIFF or PNG.',
    );
  };
  const unsupported = () => {
    throw new Error(
      'Unsupported TIFF format. Use 8/16-bit unsigned grayscale or RGB(A), chunky pixels, with no compression, LZW, Deflate or PackBits. Export other TIFFs as PNG.',
    );
  };
  const range = (offset: number, length: number) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > buffer.byteLength
    )
      invalid();
  };
  range(0, 8);
  const order = view.getUint16(0),
    le = order === 0x4949;
  if (order !== 0x4949 && order !== 0x4d4d) invalid();
  if (view.getUint16(2, le) !== 42) unsupported();
  const directory = view.getUint32(4, le);
  if (directory < 8) invalid();
  range(directory, 2);
  const count = view.getUint16(directory, le);
  range(directory + 2, count * 12 + 4);
  const tags = new Set([
    256, 257, 258, 259, 262, 266, 273, 274, 277, 278, 279, 284, 317, 320, 322,
    323, 324, 325, 338, 339,
  ]);
  const image: TiffImage = {};
  for (let i = 0; i < count; i++) {
    const entry = directory + 2 + i * 12,
      tag = view.getUint16(entry, le);
    if (!tags.has(tag)) continue;
    if (image[`t${tag}`]) invalid();
    const type = view.getUint16(entry + 2, le),
      length = view.getUint32(entry + 4, le);
    if (![3, 4].includes(type) || !length || length > 1_000_000) unsupported();
    const stride = type === 3 ? 2 : 4;
    const offset =
      length * stride <= 4 ? entry + 8 : view.getUint32(entry + 8, le);
    range(offset, length * stride);
    image[`t${tag}`] = Array.from({ length }, (_, j) =>
      type === 3
        ? view.getUint16(offset + j * stride, le)
        : view.getUint32(offset + j * stride, le),
    );
  }
  const one = (tag: number, fallback = 0) => image[`t${tag}`]?.[0] ?? fallback;
  const width = one(256),
    height = one(257);
  checkTextureDimensions(width, height);
  const depth = one(258, 1),
    samples = one(277, 1),
    photo = one(262, -1);
  const compression = one(259, 1),
    orientation = one(274, 1),
    alpha = one(338);
  const baseSamples = photo === 2 ? 3 : 1;
  if (
    ![8, 16].includes(depth) ||
    ![0, 1, 2, 3].includes(photo) ||
    ![baseSamples, baseSamples + 1].includes(samples) ||
    (photo === 3 && (depth !== 8 || samples !== 1)) ||
    image.t258?.some((bits) => bits !== depth) ||
    image.t339?.some((format) => format !== 1) ||
    one(284, 1) !== 1 ||
    one(266, 1) !== 1 ||
    ![1, 2].includes(one(317, 1)) ||
    ![1, 5, 8, 32946, 32773].includes(compression) ||
    orientation < 1 ||
    orientation > 8 ||
    (image.t338 &&
      (image.t338.length !== 1 || alpha > 2 || samples !== baseSamples + 1))
  )
    unsupported();
  if (photo === 3 && image.t320?.length !== 768) invalid();
  const tiled = !!image.t322;
  const blockWidth = tiled ? one(322) : width,
    blockHeight = tiled ? one(323) : Math.min(one(278, height), height);
  checkTextureDimensions(blockWidth, blockHeight);
  const offsets = tiled ? image.t324 : image.t273,
    lengths = tiled ? image.t325 : image.t279;
  const blocks =
    Math.ceil(width / blockWidth) * Math.ceil(height / blockHeight);
  if (
    !offsets ||
    !lengths ||
    offsets.length !== blocks ||
    lengths.length !== blocks
  )
    invalid();
  for (let i = 0; i < blocks; i++) {
    range(offsets[i], lengths[i]);
    if (!lengths[i]) invalid();
    if (
      compression === 1 &&
      lengths[i] <
        (blockWidth *
          (tiled
            ? blockHeight
            : Math.min(blockHeight, height - i * blockHeight)) *
          samples *
          depth) /
          8
    )
      invalid();
    if ([8, 32946].includes(compression) && lengths[i] < 6) invalid();
    await validateTiffBlock(
      new Uint8Array(buffer, offsets[i], lengths[i]),
      compression,
      (blockWidth *
        (tiled
          ? blockHeight
          : Math.min(blockHeight, height - i * blockHeight)) *
        samples *
        depth) /
        8,
    );
  }
  UTIF.decodeImage(buffer, image);
  if (
    !image.data ||
    image.data.length !== (width * height * samples * depth) / 8
  )
    invalid();
  // UTIF normalizes 16-bit samples to little endian before undoing prediction.
  const raw = new DataView(
    image.data!.buffer,
    image.data!.byteOffset,
    image.data!.byteLength,
  );
  const max = depth === 16 ? 65535 : 255;
  const rgba =
    depth === 16
      ? new Uint16Array(width * height * 4)
      : new Uint8Array(width * height * 4);
  const outWidth = orientation >= 5 ? height : width,
    outHeight = orientation >= 5 ? width : height;
  const flipX = [2, 3, 6, 7].includes(orientation),
    flipY = [3, 4, 7, 8].includes(orientation);
  const hasAlpha = samples === baseSamples + 1 && (alpha === 1 || alpha === 2);
  const sample = (pixel: number, channel: number) =>
    depth === 16
      ? raw.getUint16((pixel * samples + channel) * 2, true)
      : raw.getUint8(pixel * samples + channel);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let ox = orientation >= 5 ? y : x,
        oy = orientation >= 5 ? x : y;
      if (flipX) ox = outWidth - 1 - ox;
      if (flipY) oy = outHeight - 1 - oy;
      const target = (oy * outWidth + ox) * 4,
        a = hasAlpha ? sample(p, baseSamples) : max;
      for (let c = 0; c < 3; c++) {
        let value = photo === 2 ? sample(p, c) : sample(p, 0);
        if (photo === 0) value = max - value;
        if (photo === 3) value = Math.round(image.t320[c * 256 + value] / 257);
        if (alpha === 1)
          value = a ? Math.min(max, Math.round((value * max) / a)) : 0;
        rgba[target + c] = value;
      }
      rgba[target + 3] = a;
    }
  return { width: outWidth, height: outHeight, rgba, hasAlpha };
}
