import type { FoliageModel, TerrainProject } from '../core/types';
import { editFoliageModels } from '../core/foliage';
import { assertProjectCapacity } from '../core/project-package';
import { checkSignal } from '../render/resources';
import { checkModelFileSize } from '../core/model-limits';
import { bytesToBase64 } from '../core/base64';

type Gltf = {
  asset: { version: string; [key: string]: unknown };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: Record<string, unknown>[];
  buffers?: { uri?: string; byteLength: number }[];
  images?: { uri?: string }[];
  [key: string]: unknown;
};
export interface ModelDocument {
  json: Gltf;
  chunks: { type: number; bytes: Uint8Array }[];
}
export function readModelDocument(buffer: ArrayBuffer): ModelDocument {
  const view = new DataView(buffer);
  if (
    buffer.byteLength < 20 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== buffer.byteLength
  )
    throw new Error('Invalid GLB container. Export a glTF 2.0 binary model.');
  const chunks: ModelDocument['chunks'] = [];
  let json: Gltf | undefined;
  for (let at = 12; at < buffer.byteLength;) {
    if (at + 8 > buffer.byteLength) throw new Error('Truncated GLB chunk.');
    const length = view.getUint32(at, true),
      type = view.getUint32(at + 4, true);
    if (length % 4 || at + 8 + length > buffer.byteLength)
      throw new Error('Invalid GLB chunk length.');
    const bytes = new Uint8Array(buffer, at + 8, length);
    if (at === 12 && type === 0x4e4f534a)
      json = JSON.parse(new TextDecoder().decode(bytes));
    else {
      if (
        type === 0x4e4f534a ||
        (type === 0x004e4942 && chunks.some((chunk) => chunk.type === type))
      )
        throw new Error('GLB contains duplicate JSON or binary chunks.');
      chunks.push({ type, bytes });
    }
    at += 8 + length;
  }
  if (!json || json.asset?.version !== '2.0')
    throw new Error('Use a glTF 2.0 model.');
  return { json, chunks };
}
export function writeModelDocument(document: ModelDocument): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(document.json));
  const length = Math.ceil(json.length / 4) * 4;
  const size =
    20 +
    length +
    document.chunks.reduce((n, chunk) => n + 8 + chunk.bytes.length, 0);
  checkModelFileSize(size, 'Prepared model');
  const buffer = new ArrayBuffer(size),
    view = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, size, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + length);
  bytes.set(json, 20);
  let at = 20 + length;
  document.chunks.forEach((chunk) => {
    view.setUint32(at, chunk.bytes.length, true);
    view.setUint32(at + 4, chunk.type, true);
    bytes.set(chunk.bytes, at + 8);
    at += 8 + chunk.bytes.length;
  });
  return buffer;
}
export function modelDataURL(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  checkModelFileSize(bytes.byteLength);
  return 'data:model/gltf-binary;base64,' + bytesToBase64(bytes);
}
function normalizedPath(value: string) {
  const parts: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (part === '..') {
      if (!parts.length)
        throw new Error('Dependency path leaves the selected folder.');
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
export class ModelDependencyError extends Error {}
/** Package only explicitly supplied dependencies; never fetch model URLs. */
export async function bundleModel(
  file: File,
  files: File[],
  signal?: AbortSignal,
): Promise<ModelDocument> {
  checkSignal(signal);
  checkModelFileSize(file.size, file.name);
  const bytes = await file.arrayBuffer();
  checkSignal(signal);
  const document: ModelDocument = /\.glb$/i.test(file.name)
    ? readModelDocument(bytes)
    : { json: JSON.parse(new TextDecoder().decode(bytes)), chunks: [] };
  if (document.json.asset?.version !== '2.0')
    throw new Error('Use glTF 2.0 models.');
  const modelPath = normalizedPath(file.webkitRelativePath || file.name);
  const base = modelPath.includes('/')
    ? modelPath.slice(0, modelPath.lastIndexOf('/') + 1)
    : '';
  let total = file.size;
  for (const item of [
    ...(document.json.buffers ?? []),
    ...(document.json.images ?? []),
  ]) {
    if (!item.uri || item.uri.startsWith('data:')) continue;
    if (/^[a-z]+:|^[/\\]/i.test(item.uri))
      throw new Error(
        `External URL is unsupported: ${item.uri}. Supply local textures and buffers.`,
      );
    const uri = decodeURIComponent(item.uri);
    const path = normalizedPath(base + uri);
    let matches = files.filter(
      (source) =>
        normalizedPath(source.webkitRelativePath || source.name) === path,
    );
    // A multi-file chooser drops directory structure. Use a basename only when unique.
    if (!matches.length && !files.some((source) => source.webkitRelativePath))
      matches = files.filter(
        (source) => source.name === path.split('/').at(-1),
      );
    if (matches.length !== 1)
      throw new ModelDependencyError(
        `${matches.length ? 'Ambiguous' : 'Missing'} dependency “${item.uri}” for ${file.name}. The browser can only read selected files. Choose the model folder to include its BIN and textures, or add the missing files.`,
      );
    const dependency = matches[0];
    total += dependency.size;
    checkModelFileSize(total, `${file.name} and its dependencies`);
    const data = new Uint8Array(await dependency.arrayBuffer());
    checkSignal(signal);
    // Keep the usual single external geometry buffer in the GLB's binary
    // chunk. A base64 URI inside GLB JSON adds another full encoded copy of
    // large meshes during parsing, transformation and project persistence.
    if (
      document.json.buffers?.length === 1 &&
      item === document.json.buffers[0] &&
      !document.chunks.some((chunk) => chunk.type === 0x004e4942)
    ) {
      const length = document.json.buffers[0].byteLength;
      if (!Number.isSafeInteger(length) || length < 0 || data.length < length)
        throw new Error(`Truncated geometry buffer: ${dependency.name}.`);
      const content = data.subarray(0, length);
      const padded =
        length % 4 ? new Uint8Array(Math.ceil(length / 4) * 4) : content;
      if (padded !== content) padded.set(content);
      document.chunks.unshift({ type: 0x004e4942, bytes: padded });
      delete item.uri;
      continue;
    }
    const mime = /\.png$/i.test(dependency.name)
      ? 'image/png'
      : /\.jpe?g$/i.test(dependency.name)
        ? 'image/jpeg'
        : /\.webp$/i.test(dependency.name)
          ? 'image/webp'
          : 'application/octet-stream';
    item.uri = `data:${mime};base64,${bytesToBase64(data)}`;
  }
  // Check without allocating a second full binary container just to discard it.
  const jsonBytes = new Blob([JSON.stringify(document.json)]).size;
  checkModelFileSize(
    20 +
      Math.ceil(jsonBytes / 4) * 4 +
      document.chunks.reduce((sum, chunk) => sum + 8 + chunk.bytes.length, 0),
    'Prepared model',
  );
  return document;
}
export function transformModel(
  document: ModelDocument,
  scale: number,
  offset: [number, number, number],
) {
  if (!Number.isFinite(scale) || scale <= 0 || !offset.every(Number.isFinite))
    throw new Error('Invalid model transform.');
  const json = structuredClone(document.json);
  const scene = json.scenes?.[json.scene ?? 0];
  if (!scene?.nodes?.length)
    throw new Error('The selected glTF scene contains no root nodes.');
  json.nodes ??= [];
  const root = json.nodes.length;
  json.nodes.push({
    name: 'Terrain Studio import transform',
    children: [...scene.nodes],
    scale: [scale, scale, scale],
    translation: offset.map((n) => n * scale),
  });
  scene.nodes = [root];
  return modelDataURL(writeModelDocument({ json, chunks: document.chunks }));
}
export interface FoliageImportOptions {
  mode: 'new' | 'add' | 'replace';
  name: string;
  profile: 'ground' | 'tree' | 'rigid';
  materials: string[];
  targetBrush: number;
  targetModel: number;
}
export interface ImportedPlant {
  name: string;
  data: string;
  width: number;
}
/** Isolated document; resource preparation and history remain the caller's responsibility. */
export function foliageImportDraft(
  project: TerrainProject,
  plants: ImportedPlant[],
  options: FoliageImportOptions,
) {
  if (!plants.length || plants.length > 32)
    throw new Error('Choose between 1 and 32 models.');
  if (options.mode === 'replace' && plants.length !== 1)
    throw new Error(
      'Replacement accepts one model. Use a new brush or add variants for a batch.',
    );
  if (Object.keys(project.assets).length + plants.length > 256)
    throw new Error('Maximum 256 model assets. Remove unused assets first.');
  if (options.mode === 'new' && project.brushes.length >= 256)
    throw new Error('Maximum 256 foliage brushes.');
  const next = structuredClone(project);
  const models: FoliageModel[] = plants.map((plant) => {
    const id = 'asset-' + next.nextId++;
    next.assets[id] = { name: plant.name.slice(0, 120), data: plant.data };
    const tree = options.profile === 'tree',
      rigid = options.profile === 'rigid';
    return {
      id: 'variant-' + next.nextId++,
      model: id,
      weight: 1,
      minScale: 0.85,
      maxScale: 1.15,
      minRotation: -180,
      maxRotation: 180,
      alignToNormal: !tree,
      wind: rigid ? 0 : tree ? 0.25 : 0.5,
      crush: rigid || tree ? 0 : 0.4,
      color: '#ffffff',
      interaction: { enabled: !rigid && !tree, radius: 4, recovery: 2.5 },
      flexibility: {
        source: 'height',
        start: tree ? 0.4 : 0.05,
        end: 1,
        exponent: tree ? 2 : 1.5,
      },
    };
  });
  let brushIndex = options.targetBrush;
  if (options.mode === 'new') {
    if (
      !options.materials.length ||
      options.materials.some(
        (id) => !project.materials.some((m) => m.id === id),
      )
    )
      throw new Error('Choose at least one allowed terrain surface.');
    const spacing = Math.max(
      0.1,
      Math.min(20, Math.max(...plants.map((p) => p.width)) * 0.6),
    );
    const model = models[0];
    next.brushes.push({
      id: 'brush-' + next.nextId++,
      name: options.name.trim().slice(0, 120) || 'Imported foliage',
      model: model.model,
      models,
      materials: [...options.materials],
      minWeight: 0.25,
      density: Math.min(8, 0.6 / (spacing * spacing)),
      spacing,
      minScale: model.minScale,
      maxScale: model.maxScale,
      rotation: 180,
      alignToNormal: model.alignToNormal,
      maxSlope: options.profile === 'tree' ? 35 : 55,
      wind: model.wind,
      crush: model.crush,
      color: '#ffffff',
    });
    brushIndex = next.brushes.length - 1;
  } else {
    const brush = next.brushes[brushIndex];
    if (!brush) throw new Error('The target brush no longer exists.');
    const entries = editFoliageModels(brush, next.foliage);
    if (options.mode === 'add') {
      if (entries.length + models.length > 32)
        throw new Error(
          'A brush can contain up to 32 variants. Choose New brush for this batch.',
        );
      entries.push(...models);
    } else {
      const selected = entries[options.targetModel];
      if (!selected) throw new Error('The selected model no longer exists.');
      selected.model = models[0].model;
      selected.lods = []; // Previous LODs do not match a replacement model.
    }
  }
  assertProjectCapacity(next);
  return { project: next, brushIndex };
}
