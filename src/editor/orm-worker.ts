import { decodeHeightmapPNG, encodeRgbaPNG } from '../core/heightmap-png';
import type { PNGChannel } from '../core/heightmap-png';
import { packOrmMap } from '../core/orm';
import type { OrmSources } from '../core/orm';
import { decodeTexture, textureChannel, textureRgba8 } from './texture-decode';
import type { DecodedTexture } from './texture-decode';
import { needsTextureConversion } from './texture-formats';
import {
  checkTextureFileSize,
  checkTextureDimensions,
} from '../core/texture-limits';
import { checkTextureFile } from './texture-file';
export interface TextureRequest {
  convert: ArrayBuffer;
  name: string;
}
export type OrmSlot = 'occlusion' | 'roughness' | 'metalness';
export interface OrmRequest {
  resolution: number;
  sources: Partial<
    Record<
      OrmSlot,
      {
        png: ArrayBuffer;
        channel: PNGChannel;
        mime?: string;
        name?: string;
        requireAlpha?: boolean;
      }
    >
  >;
  gloss: boolean;
}
export type OrmResponse =
  | { type: 'progress'; message: string }
  | { type: 'result'; png: ArrayBuffer; preview: Uint8Array }
  | { type: 'error'; message: string };
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<OrmRequest | TextureRequest>) => void;
  postMessage: (response: OrmResponse, transfer?: Transferable[]) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    if ('convert' in data) {
      const image = await decodeTexture(data.convert, data.name);
      const png = await encodeRgbaPNG(
        image.width,
        image.height,
        textureRgba8(image),
      );
      scope.postMessage({ type: 'result', png, preview: new Uint8Array() }, [
        png,
      ]);
      return;
    }
    if (![256, 512, 1024, 2048].includes(data.resolution))
      throw new Error('Invalid ORM resolution.');
    const maps: OrmSources = { roughnessIsGloss: data.gloss };
    const decoded = new Map<ArrayBuffer, DecodedTexture>();
    for (const slot of ['occlusion', 'roughness', 'metalness'] as const) {
      const source = data.sources[slot];
      if (!source) continue;
      checkTextureFileSize(source.png.byteLength);
      const convert = needsTextureConversion(source.name ?? '');
      if (
        source.requireAlpha &&
        !convert &&
        new Uint8Array(source.png)[0] !== 137
      )
        throw new Error(
          'Unity packed smoothness needs a PNG, TIFF or TGA with alpha to preserve numeric channels. Choose an image with alpha or separate map roles.',
        );
      scope.postMessage({
        type: 'progress',
        message: 'Reading ' + slot + ' channel…',
      });
      if (convert) {
        let image = decoded.get(source.png);
        if (!image) {
          image = await decodeTexture(source.png, source.name!);
          decoded.set(source.png, image);
        }
        maps[slot] = textureChannel(image, source.channel, source.requireAlpha);
      } else if (
        !source.mime ||
        source.mime === 'image/png' ||
        new Uint8Array(source.png)[0] === 137
      ) {
        maps[slot] = await decodeHeightmapPNG(
          source.png,
          false,
          source.channel,
          source.requireAlpha,
        );
      } else {
        await checkTextureFile(
          new File([source.png], source.name ?? 'channel.jpg'),
        );
        const bitmap = await createImageBitmap(
          new Blob([source.png], { type: source.mime }),
          { colorSpaceConversion: 'none' },
        );
        try {
          checkTextureDimensions(bitmap.width, bitmap.height);
          const canvas = new OffscreenCanvas(data.resolution, data.resolution);
          const context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0, data.resolution, data.resolution);
          const rgba = context.getImageData(
            0,
            0,
            data.resolution,
            data.resolution,
          ).data;
          const values = new Float32Array(data.resolution ** 2);
          const channel = { red: 0, green: 1, blue: 2, alpha: 3, luminance: 0 }[
            source.channel
          ];
          for (let i = 0; i < values.length; i++)
            values[i] =
              (source.channel === 'luminance'
                ? rgba[i * 4] * 0.2126 +
                  rgba[i * 4 + 1] * 0.7152 +
                  rgba[i * 4 + 2] * 0.0722
                : rgba[i * 4 + channel]) / 255;
          maps[slot] = {
            width: data.resolution,
            height: data.resolution,
            values,
          };
        } finally {
          bitmap.close();
        }
      }
    }
    scope.postMessage({
      type: 'progress',
      message: 'Packing and compressing ORM…',
    });
    const pixels = packOrmMap(maps, data.resolution);
    const png = await encodeRgbaPNG(data.resolution, data.resolution, pixels);
    const preview = packOrmMap(maps, 128);
    scope.postMessage({ type: 'result', png, preview }, [
      png,
      preview.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
