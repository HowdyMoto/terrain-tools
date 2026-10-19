/** Inspect bounded scanline OpenEXR data before the decoder allocates its image. */
export function inspectEnvironmentEXR(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer),
    view = new DataView(buffer);
  const fail = (message: string): never => {
    throw new Error('EXR environment: ' + message);
  };
  if (bytes.length < 8 || view.getUint32(0, true) !== 20000630)
    fail('invalid OpenEXR signature.');
  const version = view.getUint32(4, true);
  if ((version & 255) !== 2 || (version & ~0x402) !== 0)
    fail('use a single-part scanline image, without tiles or deep samples.');
  let offset = 8;
  const string = (end: number) => {
    const start = offset;
    while (offset < end && bytes[offset] !== 0) {
      if (bytes[offset] > 127 || offset - start > 255)
        fail('invalid header name.');
      offset++;
    }
    if (offset >= end) fail('unterminated header name.');
    return new TextDecoder().decode(bytes.subarray(start, offset++));
  };
  const attributes = new Map<
    string,
    { type: string; start: number; size: number; raw: Uint8Array }
  >();
  while (true) {
    const start = offset,
      name = string(Math.min(bytes.length, 65536));
    if (!name) break;
    const type = string(Math.min(bytes.length, 65536));
    if (offset + 4 > bytes.length) fail('truncated header.');
    const size = view.getUint32(offset, true);
    offset += 4;
    if (offset + size > Math.min(bytes.length, 65536) || attributes.has(name))
      fail('oversized, duplicate or truncated header attribute.');
    attributes.set(name, {
      type,
      start: offset,
      size,
      raw: bytes.subarray(start, offset + size),
    });
    offset += size;
  }
  const attribute = (name: string, type: string, size?: number) => {
    const value = attributes.get(name);
    if (
      !value ||
      value.type !== type ||
      (size !== undefined && value.size !== size)
    )
      return fail('missing or invalid ' + name + '.');
    return value;
  };
  const window = attribute('dataWindow', 'box2i', 16);
  const display = attribute('displayWindow', 'box2i', 16);
  const bounds = Array.from({ length: 4 }, (_, i) =>
    view.getInt32(window.start + i * 4, true),
  );
  const [minX, minY, maxX, maxY] = bounds;
  const width = maxX - minX + 1,
    height = maxY - minY + 1;
  if (
    width < 64 ||
    height < 32 ||
    width > 4096 ||
    height > 2048 ||
    width !== height * 2
  )
    fail('use a 2:1 equirectangular image, from 64 × 32 to 4096 × 2048.');
  if (bounds.some((v, i) => v !== view.getInt32(display.start + i * 4, true)))
    fail('cropped data windows are unsupported; export the complete panorama.');
  if (view.getUint8(attribute('lineOrder', 'lineOrder', 1).start) !== 0)
    fail('export scanlines in increasing Y order.');
  const aspect = attributes.get('pixelAspectRatio');
  if (
    aspect &&
    (aspect.type !== 'float' ||
      aspect.size !== 4 ||
      !Number.isFinite(view.getFloat32(aspect.start, true)) ||
      Math.abs(view.getFloat32(aspect.start, true) - 1) > 1e-6)
  )
    fail('pixels must be square.');
  const envmap = attributes.get('envmap');
  if (
    envmap &&
    (envmap.type !== 'envmap' || envmap.size !== 1 || bytes[envmap.start] !== 0)
  )
    fail('use a latitude-longitude panorama, not a cube map.');
  const chromaticities = attributes.get('chromaticities');
  if (chromaticities) {
    const rec709 = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329];
    if (
      chromaticities.type !== 'chromaticities' ||
      chromaticities.size !== 32 ||
      rec709.some((v, i) => {
        const actual = view.getFloat32(chromaticities.start + i * 4, true);
        return !Number.isFinite(actual) || Math.abs(actual - v) > 0.001;
      })
    )
      fail(
        'convert the panorama to linear sRGB / Rec.709 primaries before importing.',
      );
  }
  const compression = bytes[attribute('compression', 'compression', 1).start];
  const blockHeight = [1, 1, 1, 16, 32, 16, 0, 0, 32, 256][compression];
  if (!blockHeight)
    fail('unsupported compression; use NONE, RLE, ZIP(S), PIZ, PXR24 or DWA.');
  const channelList = attribute('channels', 'chlist');
  const headerEnd = offset;
  offset = channelList.start;
  const channelEnd = offset + channelList.size;
  const channels = new Set<string>();
  let sampleType = 0;
  while (offset < channelEnd) {
    const name = string(channelEnd);
    if (!name) break;
    if (
      !['R', 'G', 'B', 'A'].includes(name) ||
      channels.has(name) ||
      offset + 16 > channelEnd
    )
      fail('use RGB or RGBA channels without layers or extra passes.');
    const type = view.getInt32(offset, true);
    if (
      ![1, 2].includes(type) ||
      (sampleType && type !== sampleType) ||
      view.getInt32(offset + 8, true) !== 1 ||
      view.getInt32(offset + 12, true) !== 1
    )
      fail(
        'channels must use matching HALF or FLOAT samples without subsampling.',
      );
    sampleType = type;
    channels.add(name);
    offset += 16;
  }
  if (
    offset !== channelEnd ||
    bytes[offset - 1] !== 0 ||
    !['R', 'G', 'B'].every((c) => channels.has(c))
  )
    fail('incomplete RGB channel list.');
  const blocks = Math.ceil(height / blockHeight),
    tableEnd = headerEnd + blocks * 8;
  if (tableEnd > bytes.length) fail('truncated scanline table.');
  const chunks: Uint8Array[] = [],
    ranges: [number, number][] = [];
  for (let i = 0; i < blocks; i++) {
    const address = view.getBigUint64(headerEnd + i * 8, true);
    if (address < BigInt(tableEnd) || address + 8n > BigInt(bytes.length))
      fail('invalid scanline offset.');
    const start = Number(address),
      line = view.getInt32(start, true),
      size = view.getUint32(start + 4, true);
    const rawSize =
      Math.min(blockHeight, height - i * blockHeight) *
      width *
      channels.size *
      sampleType *
      2;
    if (
      line !== minY + i * blockHeight ||
      !size ||
      size > rawSize ||
      (compression === 0 && size !== rawSize) ||
      start + 8 + size > bytes.length
    )
      fail('truncated or invalid scanline block.');
    chunks.push(bytes.subarray(start, start + 8 + size));
    ranges.push([start, start + 8 + size]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i][0] < ranges[i - 1][1]) fail('overlapping scanline blocks.');
  // Three r180 reads blocks sequentially. Normalize file order using the offset
  // table, and omit optional header types its parser need not interpret.
  const header = [
    'channels',
    'compression',
    'dataWindow',
    'displayWindow',
    'lineOrder',
  ].map((name) => attributes.get(name)!.raw);
  const headerSize = 8 + header.reduce((sum, item) => sum + item.length, 0) + 1;
  const canonical = new Uint8Array(
    headerSize +
      blocks * 8 +
      chunks.reduce((sum, item) => sum + item.length, 0),
  );
  canonical.set(bytes.subarray(0, 8));
  let cursor = 8;
  for (const item of header) {
    canonical.set(item, cursor);
    cursor += item.length;
  }
  cursor++;
  let chunkOffset = headerSize + blocks * 8;
  const canonicalView = new DataView(canonical.buffer);
  for (const chunk of chunks) {
    canonicalView.setBigUint64(cursor, BigInt(chunkOffset), true);
    cursor += 8;
    canonical.set(chunk, chunkOffset);
    chunkOffset += chunk.length;
  }
  return { width, height, buffer: canonical.buffer };
}
