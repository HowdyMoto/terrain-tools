/** Independent tiny TIFF/TGA writers used to exercise import byte layouts. */
export function tiffFixture(
  options: {
    width?: number;
    height?: number;
    bits?: number;
    channels?: number;
    pixels?: number[];
    littleEndian?: boolean;
    tags?: Record<number, number[]>;
  } = {},
): ArrayBuffer {
  const {
    width = 1,
    height = 1,
    bits = 8,
    channels = 4,
    pixels = [17, 102, 153, 204],
    littleEndian: le = true,
  } = options;
  const tags: Record<number, number[]> = {
    256: [width],
    257: [height],
    258: Array<number>(channels).fill(bits),
    259: [1],
    262: [channels >= 3 ? 2 : 1],
    273: [0],
    277: [channels],
    278: [height],
    279: [(pixels.length * bits) / 8],
  };
  if (channels === 2 || channels === 4) tags[338] = [2];
  Object.assign(tags, options.tags);
  const entries = Object.entries(tags).map(([tag, values]) => ({
    tag: Number(tag),
    values,
  }));
  let payload = 8 + 2 + entries.length * 12 + 4;
  const extra = entries.reduce(
    (sum, { values }) => sum + (values.length > 1 ? values.length * 4 : 0),
    0,
  );
  const pixelOffset = payload + extra;
  const buffer = new ArrayBuffer(pixelOffset + (pixels.length * bits) / 8),
    view = new DataView(buffer);
  view.setUint16(0, le ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, le);
  view.setUint32(4, 8, le);
  view.setUint16(8, entries.length, le);
  entries.forEach(({ tag, values }, i) => {
    const offset = 10 + i * 12;
    view.setUint16(offset, tag, le);
    view.setUint16(offset + 2, 4, le);
    view.setUint32(offset + 4, values.length, le);
    if (values.length === 1)
      view.setUint32(offset + 8, tag === 273 ? pixelOffset : values[0], le);
    else {
      view.setUint32(offset + 8, payload, le);
      values.forEach((value, j) => view.setUint32(payload + j * 4, value, le));
      payload += values.length * 4;
    }
  });
  pixels.forEach((value, i) =>
    bits === 16
      ? view.setUint16(pixelOffset + i * 2, value, le)
      : view.setUint8(pixelOffset + i, value),
  );
  return buffer;
}

export function tgaFixture(
  options: {
    width?: number;
    height?: number;
    bits?: number;
    descriptor?: number;
    type?: number;
    pixels?: number[];
    palette?: number[];
    paletteStart?: number;
    paletteBits?: number;
  } = {},
): ArrayBuffer {
  const {
    width = 1,
    height = 1,
    bits = 32,
    descriptor = 40,
    type = 2,
    pixels = [153, 102, 17, 204],
    palette = [],
    paletteStart = 0,
    paletteBits = 24,
  } = options;
  const buffer = new ArrayBuffer(18 + palette.length + pixels.length),
    bytes = new Uint8Array(buffer),
    view = new DataView(buffer);
  bytes[1] = palette.length ? 1 : 0;
  bytes[2] = type;
  view.setUint16(3, paletteStart, true);
  view.setUint16(5, (palette.length * 8) / paletteBits, true);
  bytes[7] = paletteBits;
  view.setUint16(12, width, true);
  view.setUint16(14, height, true);
  bytes[16] = bits;
  bytes[17] = descriptor;
  bytes.set(palette, 18);
  bytes.set(pixels, 18 + palette.length);
  return buffer;
}
