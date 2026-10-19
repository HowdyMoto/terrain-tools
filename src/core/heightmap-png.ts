import { validateHeightmap } from './heightmap';
import type { Heightmap } from './heightmap';
import { MAX_TEXTURE_FILE_BYTES, MAX_TEXTURE_PIXELS } from './texture-limits';

// PNG byte order, filters and CRC follow https://www.w3.org/TR/png-3/.
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name: string, bytes: Uint8Array) {
  const out = new Uint8Array(bytes.length + 12),
    view = new DataView(out.buffer);
  view.setUint32(0, bytes.length);
  out.set(new TextEncoder().encode(name), 4);
  out.set(bytes, 8);
  view.setUint32(bytes.length + 8, crc(out.subarray(4, bytes.length + 8)));
  return out;
}
function concat(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
async function inflate(bytes: Uint8Array, expected: number) {
  const reader = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  const result = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > expected)
        throw new Error('PNG expands beyond its declared dimensions.');
      result.set(value, offset);
      offset += value.length;
    }
    if (offset !== expected) throw new Error('PNG image data is truncated.');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return result;
}
function paeth(left: number, up: number, corner: number) {
  const estimate = left + up - corner;
  const dl = Math.abs(estimate - left),
    du = Math.abs(estimate - up),
    dc = Math.abs(estimate - corner);
  return dl <= du && dl <= dc ? left : du <= dc ? up : corner;
}
export type PNGChannel = 'luminance' | 'red' | 'green' | 'blue' | 'alpha';
/** Preserve numeric samples without display gamma. requireAlpha rejects missing packed channels. */
export async function decodeHeightmapPNG(
  data: ArrayBuffer,
  useAlpha = false,
  channel: PNGChannel = 'luminance',
  requireAlpha = false,
): Promise<Heightmap> {
  if (!['luminance', 'red', 'green', 'blue', 'alpha'].includes(channel))
    throw new Error('Invalid PNG channel.');
  const bytes = new Uint8Array(data),
    view = new DataView(data);
  if (
    bytes.length < 45 ||
    bytes.length > MAX_TEXTURE_FILE_BYTES ||
    signature.some((v, i) => v !== bytes[i])
  )
    throw new Error('Invalid PNG signature or file size.');
  let width = 0,
    height = 0,
    depth = 0,
    color = 0,
    channels = 0;
  let header = false,
    ended = false,
    dataEnded = false,
    hadData = false;
  let palette: Uint8Array | undefined, transparency: Uint8Array | undefined;
  const parts: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk.');
    const length = view.getUint32(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated PNG chunk.');
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const contents = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      crc(bytes.subarray(offset + 4, offset + 8 + length)) !==
      view.getUint32(end - 4)
    )
      throw new Error('PNG checksum mismatch.');
    if (!header && name !== 'IHDR')
      throw new Error('PNG header must be first.');
    if (name === 'IHDR') {
      if (header || length !== 13) throw new Error('Invalid PNG header.');
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = contents[8];
      color = contents[9];
      const valid: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[
        color
      ];
      if (!valid[color]?.includes(depth) || contents[10] || contents[11])
        throw new Error('Unsupported PNG encoding.');
      if (contents[12]) throw new Error('Use a non-interlaced PNG heightmap.');
      if (
        !width ||
        !height ||
        width > 8192 ||
        height > 8192 ||
        width * height > 16_777_216
      )
        throw new Error(
          'PNG heightmaps support up to 16 megapixels, with each side at most 8192.',
        );
      header = true;
    } else if (name === 'PLTE') {
      if (
        palette ||
        hadData ||
        color === 0 ||
        color === 4 ||
        length < 3 ||
        length > 768 ||
        length % 3 ||
        (color === 3 && length / 3 > 2 ** depth)
      )
        throw new Error('Invalid PNG palette.');
      palette = contents;
    } else if (name === 'tRNS') {
      if (
        transparency ||
        hadData ||
        (color === 0
          ? length !== 2
          : color === 2
            ? length !== 6
            : color === 3
              ? !palette || length > palette.length / 3
              : true)
      )
        throw new Error('Invalid PNG transparency.');
      transparency = contents;
    } else if (name === 'IDAT') {
      if (dataEnded) throw new Error('PNG data chunks must be consecutive.');
      parts.push(contents);
      hadData = true;
    } else if (name === 'IEND') {
      if (length || !hadData || end !== bytes.length)
        throw new Error('Invalid PNG end chunk.');
      ended = true;
      break;
    } else {
      if (hadData) dataEnded = true;
      if (name === 'acTL') throw new Error('Use a static PNG heightmap.');
      if ((bytes[offset + 4] & 32) === 0)
        throw new Error('Unsupported PNG critical chunk: ' + name);
    }
    offset = end;
  }
  if (!ended || (color === 3 && !palette))
    throw new Error('Incomplete PNG image.');
  if (requireAlpha && color !== 4 && color !== 6 && !transparency)
    throw new Error(
      'This map has no alpha channel for smoothness. Use an RGBA PNG, or select Metalness and supply roughness separately.',
    );
  const rowBytes = Math.ceil((width * channels * depth) / 8),
    bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const raw = await inflate(concat(parts), (rowBytes + 1) * height);
  const rows = new Uint8Array(rowBytes * height),
    values = new Float32Array(width * height);
  const maximum = 2 ** depth - 1;
  const transparentView = transparency
    ? new DataView(
        transparency.buffer,
        transparency.byteOffset,
        transparency.byteLength,
      )
    : undefined;
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes,
      filter = raw[y * (rowBytes + 1)];
    if (filter > 4) throw new Error('Invalid PNG row filter.');
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? rows[row + i - bpp] : 0;
      const up = y ? rows[row + i - rowBytes] : 0;
      const corner = y && i >= bpp ? rows[row + i - rowBytes - bpp] : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : filter === 4
                ? paeth(left, up, corner)
                : 0;
      rows[row + i] = raw[y * (rowBytes + 1) + i + 1] + predictor;
    }
    const sample = (index: number) =>
      depth === 16
        ? rows[row + index * 2] * 256 + rows[row + index * 2 + 1]
        : depth === 8
          ? rows[row + index]
          : (rows[row + Math.floor((index * depth) / 8)] >>>
              (8 - depth - ((index * depth) % 8))) &
            maximum;
    for (let x = 0; x < width; x++) {
      const start = x * channels;
      let red: number, green: number, blue: number;
      let value: number,
        alpha = 1;
      if (color === 3) {
        const index = sample(x);
        if (index * 3 + 2 >= palette!.length)
          throw new Error('PNG palette index is out of range.');
        value =
          (palette![index * 3] * 0.2126 +
            palette![index * 3 + 1] * 0.7152 +
            palette![index * 3 + 2] * 0.0722) /
          255;
        red = palette![index * 3] / 255;
        green = palette![index * 3 + 1] / 255;
        blue = palette![index * 3 + 2] / 255;
        alpha = (transparency?.[index] ?? 255) / 255;
      } else if (color === 0 || color === 4) {
        const gray = sample(start);
        value = gray / maximum;
        red = green = blue = value;
        if (color === 4) alpha = sample(start + 1) / maximum;
        else if (transparentView && gray === transparentView.getUint16(0))
          alpha = 0;
      } else {
        const r = sample(start),
          g = sample(start + 1),
          b = sample(start + 2);
        value = (r * 0.2126 + g * 0.7152 + b * 0.0722) / maximum;
        red = r / maximum;
        green = g / maximum;
        blue = b / maximum;
        if (color === 6) alpha = sample(start + 3) / maximum;
        else if (
          transparentView &&
          r === transparentView.getUint16(0) &&
          g === transparentView.getUint16(2) &&
          b === transparentView.getUint16(4)
        )
          alpha = 0;
      }
      const selected =
        channel === 'red'
          ? red
          : channel === 'green'
            ? green
            : channel === 'blue'
              ? blue
              : channel === 'alpha'
                ? alpha
                : value;
      values[y * width + x] =
        selected * (useAlpha && channel !== 'alpha' ? alpha : 1);
    }
  }
  return { width, height, values };
}
export async function encodeHeightmapPNG(map: Heightmap): Promise<ArrayBuffer> {
  validateHeightmap(map);
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, map.width);
  view.setUint32(4, map.height);
  header[8] = 16; // Grayscale, non-interlaced, with numeric samples.
  const rows = new Uint8Array(map.height * (map.width * 2 + 1)),
    pixels = new DataView(rows.buffer);
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      pixels.setUint16(
        y * (map.width * 2 + 1) + x * 2 + 1,
        Math.round(map.values[y * map.width + x] * 65535),
      );
  const compressed = new Uint8Array(
    await new Response(
      new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );
  return concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array()),
  ]).buffer;
}

/** Encode untagged RGBA8 without display gamma, up to 16 MP / 8192 per side.
 * Source-image conversion is independent of the project's 2048² render limit. */
export async function encodeRgbaPNG(
  width: number,
  height: number,
  pixels: Uint8Array,
): Promise<ArrayBuffer> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > MAX_TEXTURE_PIXELS ||
    !(pixels instanceof Uint8Array) ||
    pixels.length !== width * height * 4
  )
    throw new Error('Invalid RGBA PNG dimensions or pixels.');
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    rows.set(
      pixels.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  const compressed = new Uint8Array(
    await new Response(
      new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );
  return concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array()),
  ]).buffer;
}
