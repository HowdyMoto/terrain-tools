import type { FoliageModel, TerrainProject } from '../core/types';
import { editFoliageModels } from '../core/foliage';
import { assertProjectCapacity } from '../core/project-package';
import { checkSignal } from '../render/resources';
import { checkModelFileSize } from '../core/model-limits';
import { bytesToBase64 } from '../core/base64';
import type { ModelSource } from '../core/model-source';

export {
  readModelDocument,
  writeModelDocument,
  modelDataURL,
  transformModel,
} from '../core/model-document';
export type { ModelDocument } from '../core/model-document';
import { readModelDocument } from '../core/model-document';
import type { ModelDocument } from '../core/model-document';

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
export interface FoliageImportOptions {
  mode: 'new' | 'add' | 'replace';
  name: string;
  profile: 'ground' | 'tree' | 'rigid';
  materials: string[];
  targetBrush: number;
  targetModel: number;
}
export interface ImportedPlant {
  source?: ModelSource;
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
    next.assets[id] = {
      name: plant.name.slice(0, 120),
      data: plant.data,
      ...(plant.source ? { source: plant.source } : {}),
    };
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
