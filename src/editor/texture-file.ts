import {
  checkTextureDimensions,
  checkTextureFileSize,
} from '../core/texture-limits';
import {
  isTextureFile,
  needsTextureConversion,
  textureFormats,
} from './texture-formats';

/** Read small headers before the browser allocates pixels (including thumbnails).
 * TIFF/TGA metadata is validated by their worker decoders before allocation.
 * PNG: w3.org/TR/png-3/#11IHDR; WebP: developers.google.com/speed/webp/docs/riff_container;
 * JPEG SOF: libjpeg-turbo/src/jdmarker.c, get_sof. Full decoding still validates the image. */
export async function checkTextureFile(
  file: File,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  checkTextureFileSize(file.size);
  if (!isTextureFile(file.name))
    throw new Error('Choose a ' + textureFormats + ' image.');
  if (needsTextureConversion(file.name)) return;
  const invalid = () => {
    throw new Error(
      file.name +
        ': could not decode image dimensions. Choose a valid PNG, JPG or WebP image.',
    );
  };
  const read = async (offset: number, count: number) => {
    if (offset < 0 || offset + count > file.size) invalid();
    const bytes = new Uint8Array(
      await file.slice(offset, offset + count).arrayBuffer(),
    );
    signal?.throwIfAborted();
    return bytes;
  };
  const first = await read(0, 12);
  const ascii = (bytes: Uint8Array, offset: number, count = 4) =>
    String.fromCharCode(...bytes.subarray(offset, offset + count));
  const checked = (width: number, height: number) =>
    checkTextureDimensions(width, height);
  if (
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => first[i] === value)
  ) {
    const header = await read(8, 16),
      view = new DataView(header.buffer);
    if (view.getUint32(0) !== 13 || ascii(header, 4) !== 'IHDR') invalid();
    return checked(view.getUint32(8), view.getUint32(12));
  }
  if (first[0] === 255 && first[1] === 216) {
    let offset = 2;
    for (let markers = 0; markers < 4096; markers++) {
      const start = await read(offset, 2);
      if (start[0] !== 255) invalid();
      if (start[1] === 255) {
        offset++;
        continue;
      }
      const marker = start[1];
      if (marker === 217 || marker === 218 || marker === 0) invalid();
      if (marker === 1 || (marker >= 208 && marker <= 216)) {
        offset += 2;
        continue;
      }
      const size = await read(offset + 2, 2),
        length = size[0] * 256 + size[1];
      if (length < 2 || offset + 2 + length > file.size) invalid();
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      ) {
        if (length < 8) invalid();
        const dimensions = await read(offset + 5, 4);
        return checked(
          dimensions[2] * 256 + dimensions[3],
          dimensions[0] * 256 + dimensions[1],
        );
      }
      offset += 2 + length;
    }
  }
  if (ascii(first, 0) === 'RIFF' && ascii(first, 8) === 'WEBP') {
    const end = new DataView(first.buffer).getUint32(4, true) + 8;
    if (end > file.size) invalid();
    let offset = 12;
    for (let chunks = 0; chunks < 4096 && offset + 8 <= end; chunks++) {
      const header = await read(offset, 8),
        kind = ascii(header, 0);
      const size = new DataView(header.buffer).getUint32(4, true);
      if (offset + 8 + size > end) invalid();
      if (kind === 'VP8X' || kind === 'VP8 ' || kind === 'VP8L') {
        const count = kind === 'VP8L' ? 5 : 10;
        if (size < count) invalid();
        const data = await read(offset + 8, count);
        if (kind === 'VP8X')
          return checked(
            1 + data[4] + data[5] * 256 + data[6] * 65536,
            1 + data[7] + data[8] * 256 + data[9] * 65536,
          );
        if (kind === 'VP8L') {
          if (data[0] !== 47) invalid();
          const bits = new DataView(data.buffer).getUint32(1, true);
          return checked(1 + (bits & 16383), 1 + ((bits >>> 14) & 16383));
        }
        if (data[3] !== 157 || data[4] !== 1 || data[5] !== 42) invalid();
        return checked(
          (data[6] + data[7] * 256) & 16383,
          (data[8] + data[9] * 256) & 16383,
        );
      }
      offset += 8 + size + (size & 1);
    }
  }
  invalid();
}
