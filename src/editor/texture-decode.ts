import type { PNGChannel } from '../core/heightmap-png';
import type { Heightmap } from '../core/heightmap';
import { decodeTiff } from './tiff-decode';
import { decodeTga } from './tga-decode';
import { checkTextureFileSize } from '../core/texture-limits';

/** Stored, unassociated RGBA samples in top-left row order; no display gamma. */
export interface DecodedTexture {
  width: number;
  height: number;
  rgba: Uint8Array | Uint16Array;
  hasAlpha: boolean;
}

export async function decodeTexture(
  data: ArrayBuffer,
  name: string,
): Promise<DecodedTexture> {
  checkTextureFileSize(data.byteLength);
  if (/\.tiff?$/i.test(name)) return decodeTiff(data);
  if (/\.tga$/i.test(name)) return decodeTga(data);
  throw new Error('Choose a TIFF (.tif/.tiff) or TGA image to convert.');
}

export function textureChannel(
  image: DecodedTexture,
  channel: PNGChannel,
  requireAlpha = false,
): Heightmap {
  if (requireAlpha && !image.hasAlpha)
    throw new Error(
      'This map has no alpha channel. Unity packed smoothness needs an image with alpha; choose a separate map role instead.',
    );
  const values = new Float32Array(image.width * image.height);
  const max = image.rgba instanceof Uint16Array ? 65535 : 255;
  const offset = { red: 0, green: 1, blue: 2, alpha: 3, luminance: 0 }[channel];
  for (let i = 0; i < values.length; i++) {
    const p = i * 4;
    values[i] =
      (channel === 'luminance'
        ? image.rgba[p] * 0.2126 +
          image.rgba[p + 1] * 0.7152 +
          image.rgba[p + 2] * 0.0722
        : image.rgba[p + offset]) / max;
  }
  return { width: image.width, height: image.height, values };
}

/** Material texture arrays are 8-bit; ORM channel extraction happens before this. */
export function textureRgba8(image: DecodedTexture): Uint8Array {
  if (image.rgba instanceof Uint8Array) return image.rgba;
  return Uint8Array.from(image.rgba, (sample) => Math.round(sample / 257));
}
