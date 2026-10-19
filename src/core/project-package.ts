import { validateProjectData } from './serialization';
import type { TerrainProject } from './types';
import { MAX_TEXTURE_FILE_BYTES } from './texture-limits';

export const MAX_PROJECT_ASSET_BYTES = 384 * 1024 * 1024;
export const MAX_PROJECT_PACKAGE_BYTES = 512 * 1024 * 1024;
export const MAX_PROJECT_METADATA_BYTES = 64 * 1024 * 1024;
const HEADER = 32;
const MAGIC = new Uint8Array([84, 82, 78, 80, 65, 67, 75, 0]); // TRNPACK\0
const aligned = (n: number) => Math.ceil(n / 4) * 4;
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let j = 0; j < 8; j++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function packageChecksum(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    value = crcTable[(value ^ bytes[i]) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
interface Chunk {
  kind: 'float32' | 'uint8' | 'asset';
  bytes: number;
  crc: number;
  prefix?: string;
  characters?: number;
  tail?: string;
}
interface CachedAsset {
  chunk: Chunk;
  blob: Blob;
}
function assetInfo(data: string) {
  const comma = data.indexOf(',');
  if (
    comma < 1 ||
    comma > 100 ||
    !new RegExp(
      '^data:(image/(png|jpeg|webp)|model/gltf-binary|application/octet-stream);base64,$',
      'i',
    ).test(data.slice(0, comma + 1))
  )
    throw new Error('Invalid embedded asset data URL.');
  const characters = data.length - comma - 1;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((characters * 3) / 4) - padding;
  if (characters < 2 || characters % 4 === 1 || bytes < 1)
    throw new Error('Invalid embedded asset encoding.');
  return { prefix: data.slice(0, comma + 1), characters, bytes };
}
function assetUrls(project: TerrainProject) {
  return [
    ...Object.values(project.assets).map((asset) => asset.data),
    ...project.materials.flatMap((material) =>
      Object.values(material.textures),
    ),
    ...(project.environment?.image ? [project.environment.image.data] : []),
  ];
}
/** Admission check reserves separate space for terrain buffers and editable metadata. */
export function projectAssetBytes(project: TerrainProject) {
  let bytes = 0;
  for (const url of new Set(assetUrls(project))) bytes += assetInfo(url).bytes;
  return bytes;
}
export function assertProjectCapacity(
  project: TerrainProject,
  maximum = MAX_PROJECT_ASSET_BYTES,
) {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    maximum > MAX_PROJECT_ASSET_BYTES
  )
    throw new Error('Invalid project asset budget.');
  const bytes = projectAssetBytes(project);
  if (bytes > maximum)
    throw new Error(
      'Project assets exceed the ' +
        (maximum / 1048576).toFixed(0) +
        ' MiB package budget. Remove unused assets or use smaller source files.',
    );
  return bytes;
}
function bytesToBase64(bytes: Uint8Array) {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const chunks: string[] = [];
  const size = 32766; // A multiple of three avoids padding between pieces.
  for (let at = 0; at < bytes.length; at += size) {
    const end = Math.min(bytes.length, at + size);
    let binary = '';
    for (let i = at; i < end; i++) binary += String.fromCharCode(bytes[i]);
    chunks.push(btoa(binary));
  }
  return chunks.join('');
}
/** Reuses immutable asset blobs between saves; clear() releases the cache. */
export class ProjectPackageWriter {
  private assets = new Map<string, CachedAsset>();
  clear() {
    this.assets.clear();
  }
  encode(project: TerrainProject): Blob {
    assertProjectCapacity(project);
    const validated = validateProjectData(project, false);
    const chunks: Chunk[] = [],
      parts: BlobPart[] = [];
    const keep = new Map<string, CachedAsset>();
    const indices = new Map<string, number>();
    let payloadLength = 0;
    const append = (chunk: Chunk, data: BlobPart) => {
      const index = chunks.length;
      chunks.push(chunk);
      parts.push(data);
      const padding = aligned(chunk.bytes) - chunk.bytes;
      if (padding) parts.push(new Uint8Array(padding));
      payloadLength += aligned(chunk.bytes);
      return { chunk: index };
    };
    const array = (values: Float32Array | Uint8Array) => {
      let bytes: Uint8Array<ArrayBuffer>;
      if (values instanceof Float32Array && !littleEndian) {
        bytes = new Uint8Array(values.byteLength);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < values.length; i++)
          view.setFloat32(i * 4, values[i], true);
      } else
        bytes = new Uint8Array(
          values.buffer.slice(
            values.byteOffset,
            values.byteOffset + values.byteLength,
          ) as ArrayBuffer,
        );
      return append(
        {
          kind: values instanceof Float32Array ? 'float32' : 'uint8',
          bytes: bytes.length,
          crc: packageChecksum(bytes),
        },
        bytes,
      );
    };
    const asset = (url: string) => {
      const existing = indices.get(url);
      if (existing !== undefined) return { chunk: existing };
      let cached = this.assets.get(url);
      if (!cached) {
        const info = assetInfo(url);
        const raw = atob(url.slice(info.prefix.length));
        if (raw.length !== info.bytes)
          throw new Error('Invalid embedded asset length.');
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        cached = {
          chunk: {
            kind: 'asset',
            bytes: bytes.length,
            crc: packageChecksum(bytes),
            prefix: info.prefix,
            characters: info.characters,
            tail: url.slice(-Math.min(4, info.characters)),
          },
          blob: new Blob([bytes]),
        };
      }
      keep.set(url, cached);
      const ref = append(cached.chunk, cached.blob);
      indices.set(url, ref.chunk);
      return ref;
    };
    const metadata = {
      ...validated,
      heights: array(validated.heights),
      holes: array(validated.holes),
      paint: array(validated.paint),
      assets: Object.fromEntries(
        Object.entries(validated.assets).map(([key, value]) => [
          key,
          { ...value, data: asset(value.data) },
        ]),
      ),
      materials: validated.materials.map((material) => ({
        ...material,
        textures: Object.fromEntries(
          Object.entries(material.textures).map(([key, value]) => [
            key,
            asset(value),
          ]),
        ),
      })),
      ...(validated.environment?.image
        ? {
            environment: {
              ...validated.environment,
              image: {
                ...validated.environment.image,
                data: asset(validated.environment.image.data),
              },
            },
          }
        : {}),
      ...(validated.sculpt?.alpha
        ? {
            sculpt: {
              ...validated.sculpt,
              alpha: {
                ...validated.sculpt.alpha,
                values: array(validated.sculpt.alpha.values),
              },
            },
          }
        : {}),
    };
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        kind: 'terrain-project',
        version: 1,
        project: metadata,
        chunks,
      }),
    );
    const total = HEADER + aligned(manifest.length) + payloadLength;
    if (
      manifest.length > MAX_PROJECT_METADATA_BYTES ||
      total > MAX_PROJECT_PACKAGE_BYTES
    )
      throw new Error('Project exceeds the terrain package size limit.');
    const header = new Uint8Array(HEADER),
      view = new DataView(header.buffer);
    header.set(MAGIC);
    view.setUint32(8, 1, true);
    view.setUint32(12, manifest.length, true);
    view.setUint32(16, payloadLength, true);
    view.setUint32(20, packageChecksum(manifest), true);
    const blob = new Blob(
      [
        header,
        manifest,
        new Uint8Array(aligned(manifest.length) - manifest.length),
        ...parts,
      ],
      { type: 'application/x-terrain-project' },
    );
    this.assets = keep;
    return blob;
  }
}
export function serializeProjectPackage(project: TerrainProject) {
  return new ProjectPackageWriter().encode(project);
}
export function isProjectPackage(buffer: ArrayBuffer) {
  return (
    buffer.byteLength >= MAGIC.length &&
    MAGIC.every(
      (value, i) => new Uint8Array(buffer, 0, MAGIC.length)[i] === value,
    )
  );
}
/** Checks bounds, version, references and checksums before accepting an authored document. */
export function parseProjectPackage(buffer: ArrayBuffer): TerrainProject {
  if (
    buffer.byteLength < HEADER ||
    buffer.byteLength > MAX_PROJECT_PACKAGE_BYTES ||
    !isProjectPackage(buffer)
  )
    throw new Error('Invalid terrain package size or signature.');
  const view = new DataView(buffer);
  if (view.getUint32(8, true) !== 1)
    throw new Error('Unsupported terrain package version.');
  if (view.getUint32(24, true) || view.getUint32(28, true))
    throw new Error('Invalid terrain package flags.');
  const length = view.getUint32(12, true),
    payloadLength = view.getUint32(16, true),
    start = HEADER + aligned(length);
  if (
    length > MAX_PROJECT_METADATA_BYTES ||
    start + payloadLength !== buffer.byteLength
  )
    throw new Error('Invalid terrain package lengths.');
  const manifest = new Uint8Array(buffer, HEADER, length);
  if (packageChecksum(manifest) !== view.getUint32(20, true))
    throw new Error('Terrain package metadata checksum failed.');
  const raw = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(manifest),
  );
  if (
    raw?.kind !== 'terrain-project' ||
    raw.version !== 1 ||
    !Array.isArray(raw.chunks) ||
    raw.chunks.length > 300 ||
    !raw.project ||
    typeof raw.project !== 'object'
  )
    throw new Error('Invalid terrain package manifest.');
  const chunks: { descriptor: Chunk; bytes: Uint8Array }[] = [];
  let offset = start,
    assetBytes = 0;
  for (const chunk of raw.chunks) {
    if (
      !chunk ||
      !['float32', 'uint8', 'asset'].includes(chunk.kind) ||
      !Number.isSafeInteger(chunk.bytes) ||
      chunk.bytes < 1 ||
      !Number.isSafeInteger(chunk.crc) ||
      chunk.crc < 0 ||
      chunk.crc > 0xffffffff ||
      offset + aligned(chunk.bytes) > buffer.byteLength ||
      (chunk.kind === 'float32' && chunk.bytes % 4)
    )
      throw new Error('Invalid terrain package chunk.');
    if (chunk.kind === 'asset') {
      const maximum =
        typeof chunk.prefix === 'string' &&
        /^data:image\/(png|jpeg|webp);base64,$/i.test(chunk.prefix)
          ? MAX_TEXTURE_FILE_BYTES
          : 32_000_000;
      if (chunk.bytes > maximum)
        throw new Error('Terrain package asset is too large.');
      assetBytes += chunk.bytes;
    }
    if (assetBytes > MAX_PROJECT_ASSET_BYTES)
      throw new Error('Terrain package asset budget exceeded.');
    const bytes = new Uint8Array(buffer, offset, chunk.bytes);
    if (packageChecksum(bytes) !== chunk.crc)
      throw new Error('Terrain package data checksum failed.');
    chunks.push({ descriptor: chunk, bytes });
    offset += aligned(chunk.bytes);
  }
  if (offset !== buffer.byteLength)
    throw new Error('Unexpected terrain package data.');
  const referenced = new Set<number>(),
    decoded = new Map<number, string>();
  const resolve = (ref: unknown, kind: Chunk['kind']) => {
    if (
      !ref ||
      typeof ref !== 'object' ||
      !Number.isInteger((ref as { chunk: number }).chunk)
    )
      throw new Error('Invalid terrain package reference.');
    const index = (ref as { chunk: number }).chunk;
    const chunk = chunks[index];
    if (!chunk || chunk.descriptor.kind !== kind)
      throw new Error('Invalid terrain package reference kind.');
    referenced.add(index);
    return { ...chunk, index };
  };
  const floats = (ref: unknown) => {
    const { bytes } = resolve(ref, 'float32');
    if (littleEndian)
      return new Float32Array(buffer, bytes.byteOffset, bytes.byteLength / 4);
    const values = new Float32Array(bytes.byteLength / 4),
      data = new DataView(buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < values.length; i++)
      values[i] = data.getFloat32(i * 4, true);
    return values;
  };
  const asset = (ref: unknown) => {
    const { descriptor, bytes, index } = resolve(ref, 'asset');
    if (decoded.has(index)) return decoded.get(index)!;
    if (
      typeof descriptor.prefix !== 'string' ||
      !Number.isSafeInteger(descriptor.characters) ||
      typeof descriptor.tail !== 'string' ||
      descriptor.tail.length > 4 ||
      !/^[a-z0-9+/]*={0,2}$/i.test(descriptor.tail)
    )
      throw new Error('Invalid terrain package asset descriptor.');
    let base64 = bytesToBase64(bytes);
    if (
      descriptor.characters! > base64.length ||
      descriptor.characters! < base64.length - 2
    )
      throw new Error('Invalid terrain package asset length.');
    base64 = base64.slice(0, descriptor.characters);
    base64 = base64.slice(0, -descriptor.tail.length) + descriptor.tail;
    const result = descriptor.prefix + base64;
    if (assetInfo(result).bytes !== bytes.length)
      throw new Error('Invalid terrain package asset encoding.');
    // Preserve legacy padding/tail spelling, but never change the decoded bytes.
    const last = atob(
      base64.slice(Math.max(0, Math.floor((base64.length - 4) / 4) * 4)),
    );
    for (let i = 0; i < last.length; i++)
      if (last.charCodeAt(i) !== bytes[bytes.length - last.length + i])
        throw new Error('Terrain package asset tail mismatch.');
    decoded.set(index, result);
    return result;
  };
  const p = raw.project;
  p.heights = floats(p.heights);
  p.holes = resolve(p.holes, 'uint8').bytes;
  p.paint = floats(p.paint);
  if (!p.assets || typeof p.assets !== 'object' || !Array.isArray(p.materials))
    throw new Error('Invalid terrain package assets.');
  for (const value of Object.values(p.assets) as { data: unknown }[])
    value.data = asset(value.data);
  for (const material of p.materials) {
    if (!material?.textures || typeof material.textures !== 'object')
      throw new Error('Invalid terrain package maps.');
    for (const key of Object.keys(material.textures))
      material.textures[key] = asset(material.textures[key]);
  }
  if (p.environment?.image)
    p.environment.image.data = asset(p.environment.image.data);
  if (p.sculpt?.alpha) p.sculpt.alpha.values = floats(p.sculpt.alpha.values);
  if (referenced.size !== chunks.length)
    throw new Error('Unreferenced terrain package data.');
  return validateProjectData(p);
}

/** Only model assets unused by every prop, brush and LOD are eligible for cleanup. */
export function unusedModelAssetIds(project: TerrainProject): string[] {
  const used = new Set(project.props.map((prop) => prop.model));
  for (const brush of project.brushes) {
    used.add(brush.model);
    for (const model of brush.models ?? []) {
      used.add(model.model);
      for (const lod of model.lods ?? []) used.add(lod.model);
    }
  }
  return Object.keys(project.assets).filter((id) => !used.has(id));
}
