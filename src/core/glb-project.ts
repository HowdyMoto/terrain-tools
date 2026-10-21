import {
  parseProject,
  validateProjectData,
  MAX_LEGACY_PROJECT_CHARACTERS,
} from './serialization';
import {
  parseProjectPackage,
  MAX_PROJECT_PACKAGE_BYTES,
  projectPackageSources,
  MAX_PROJECT_ASSET_BYTES,
} from './project-package';
import type { ModelSource } from './model-source';
import { base64ByteLength } from './base64';
import { checkModelDataURL } from './model-limits';
import type { TerrainProject } from './types';
export const PROJECT_EXTENSION = 'TERRAIN_tools_project';
export const MAX_TERRAIN_GLB_BYTES = 1024 * 1024 * 1024;
const align = (value: number) => Math.ceil(value / 4) * 4;
function readGLB(buffer: ArrayBuffer) {
  if (buffer.byteLength < 20 || buffer.byteLength > MAX_TERRAIN_GLB_BYTES)
    throw new Error('Invalid terrain GLB size.');
  const view = new DataView(buffer);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== buffer.byteLength
  )
    throw new Error('Invalid GLB header.');
  const length = view.getUint32(12, true);
  if (
    view.getUint32(16, true) !== 0x4e4f534a ||
    length % 4 ||
    length > 128 * 1024 * 1024 ||
    length > buffer.byteLength - 20
  )
    throw new Error('Invalid GLB JSON chunk.');
  const document = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array(buffer, 20, length),
    ),
  );
  let binary: Uint8Array | undefined,
    offset = 20 + length;
  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) throw new Error('Truncated GLB chunk.');
    const bytes = view.getUint32(offset, true),
      type = view.getUint32(offset + 4, true);
    if (bytes % 4 || offset + 8 + bytes > buffer.byteLength)
      throw new Error('Invalid GLB chunk length.');
    if (type === 0x004e4942) {
      if (binary) throw new Error('Duplicate GLB binary chunk.');
      binary = new Uint8Array(buffer, offset + 8, bytes);
    }
    offset += 8 + bytes;
  }
  return { document, binary };
}
/** Read authored state without decoding the GLB's redundant presentation meshes. */
export function projectFromGLB(buffer: ArrayBuffer): TerrainProject {
  const { document, binary } = readGLB(buffer);
  const containers = [
    document,
    ...(Array.isArray(document.nodes) ? document.nodes : []),
    ...(Array.isArray(document.scenes) ? document.scenes : []),
  ];
  for (const node of containers) {
    const extension = node?.extensions?.[PROJECT_EXTENSION];
    if (!extension) continue;
    if (extension.version === 1 && extension.project)
      return validateProjectData(extension.project);
    if (extension.version === 2) {
      const index = extension.bufferView;
      const entry =
        Number.isSafeInteger(index) && index >= 0
          ? document.bufferViews?.[index]
          : undefined;
      const offset = entry?.byteOffset ?? 0,
        length = entry?.byteLength;
      if (
        !binary ||
        !entry ||
        entry.buffer !== 0 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 32 ||
        length > MAX_PROJECT_PACKAGE_BYTES ||
        offset + length > binary.length ||
        !document.buffers?.[0] ||
        offset + length > document.buffers[0].byteLength
      )
        throw new Error('Invalid terrain project buffer view.');
      return parseProjectPackage(binary.slice(offset, offset + length).buffer);
    }
    throw new Error('Unsupported terrain project extension version.');
  }
  throw new Error(
    'This GLB has no Terrain Studio project. Import a regular GLB as a model instead.',
  );
}
/** Attach the binary project in an optional v2 extension, leaving standard presentation data intact. */
export function embedProjectPackage(
  glb: ArrayBuffer,
  project: ArrayBuffer,
): ArrayBuffer {
  if (project.byteLength > MAX_PROJECT_PACKAGE_BYTES)
    throw new Error('Project exceeds the terrain package size limit.');
  const { document, binary } = readGLB(glb);
  if (document.buffers?.length > 1 || document.buffers?.[0]?.uri)
    throw new Error('Expected an embedded GLB buffer.');
  const oldBytes = binary?.length ?? 0;
  document.bufferViews ??= [];
  const index = document.bufferViews.length;
  document.bufferViews.push({
    buffer: 0,
    byteOffset: oldBytes,
    byteLength: project.byteLength,
  });
  document.buffers = [{ byteLength: oldBytes + project.byteLength }];
  document.extensions ??= {};
  document.extensions[PROJECT_EXTENSION] = { version: 2, bufferView: index };
  document.extensionsUsed = [
    ...new Set([...(document.extensionsUsed ?? []), PROJECT_EXTENSION]),
  ];
  const json = new TextEncoder().encode(JSON.stringify(document));
  const binLength = align(oldBytes + project.byteLength),
    jsonLength = align(json.length),
    total = 28 + jsonLength + binLength;
  if (total > MAX_TERRAIN_GLB_BYTES)
    throw new Error(
      'Scene GLB exceeds the 1 GiB export limit. Save a .terrain project instead.',
    );
  const result = new Uint8Array(total),
    view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  result.fill(32, 20, 20 + jsonLength);
  result.set(json, 20);
  const binAt = 20 + jsonLength;
  view.setUint32(binAt, binLength, true);
  view.setUint32(binAt + 4, 0x004e4942, true);
  if (binary) result.set(binary, binAt + 8);
  result.set(new Uint8Array(project), binAt + 8 + oldBytes);
  return result.buffer;
}
/** Dispatch by signature, so renamed project files remain readable. */
export function parseProjectFile(input: string | ArrayBuffer): TerrainProject {
  if (typeof input === 'string') return parseProject(input);
  if (
    input.byteLength >= 4 &&
    new DataView(input).getUint32(0, true) === 0x46546c67
  )
    return projectFromGLB(input);
  if (
    input.byteLength >= 8 &&
    new DataView(input).getUint32(0, true) === 0x504e5254
  )
    return parseProjectPackage(input);
  if (input.byteLength > MAX_LEGACY_PROJECT_CHARACTERS)
    throw new Error(
      'Project exceeds the legacy JSON limit. Use a .terrain package.',
    );
  return parseProject(new TextDecoder('utf-8', { fatal: true }).decode(input));
}

/** Bounds file allocation before reading a browser File or IndexedDB Blob. */
export async function readProjectFile(
  file: Blob,
  resolveModel?: (source: ModelSource) => Promise<string>,
): Promise<TerrainProject> {
  const head = await file.slice(0, 8).arrayBuffer();
  const magic =
    head.byteLength >= 4 ? new DataView(head).getUint32(0, true) : 0;
  const maximum =
    magic === 0x46546c67
      ? MAX_TERRAIN_GLB_BYTES
      : magic === 0x504e5254
        ? MAX_PROJECT_PACKAGE_BYTES
        : MAX_LEGACY_PROJECT_CHARACTERS;
  if (file.size > maximum)
    throw new Error('Project file exceeds the supported size limit.');
  const buffer = await file.arrayBuffer();
  if (
    magic === 0x504e5254 &&
    buffer.byteLength >= 32 &&
    new DataView(buffer).getUint32(8, true) === 2 &&
    resolveModel
  ) {
    const models = new Map<string, string>();
    const unique = new Map<string, string>();
    const resolved = new Map<string, string>();
    let bytes = 0;
    for (const [id, source] of Object.entries(projectPackageSources(buffer))) {
      const key = JSON.stringify(source);
      let data = resolved.get(key) ?? (await resolveModel(source));
      checkModelDataURL(data);
      if (!unique.has(data)) {
        unique.set(data, data);
        bytes += base64ByteLength(data.slice(data.indexOf(',') + 1));
      }
      data = unique.get(data)!;
      resolved.set(key, data);
      if (bytes > MAX_PROJECT_ASSET_BYTES)
        throw new Error('Linked models exceed the project asset budget.');
      models.set(id, data);
    }
    return parseProjectPackage(buffer, models);
  }
  return parseProjectFile(buffer);
}
