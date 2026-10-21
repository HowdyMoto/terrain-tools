import { ProjectPackageWriter } from './project-package';
import type { ProjectPackageMode } from './project-package';
import type { TerrainProject, MaterialLayer } from './types';
import type { EnvironmentSettings } from './environment';

type ReferenceAsset = { name: string; data: number };
type ReferenceModelAsset = Omit<TerrainProject['assets'][string], 'data'> & {
  data: number;
};
type ReferenceProject = Omit<
  TerrainProject,
  'assets' | 'materials' | 'environment'
> & {
  assets: Record<string, ReferenceModelAsset>;
  materials: (Omit<MaterialLayer, 'textures'> & {
    textures: Record<string, number>;
  })[];
  environment?: Omit<EnvironmentSettings, 'image'> & { image?: ReferenceAsset };
};
interface PackedFoliage {
  values: Float64Array;
  references: Uint32Array;
  strings: string[];
}
const foliageKeys = ['id', 'brushId', 'x', 'z', 'scale', 'rotation'];
const modelFoliageKeys = [
  'id',
  'brushId',
  'modelId',
  'x',
  'z',
  'scale',
  'rotation',
];
/** Preserve nonstandard property order/extensions through the generic cloning path. */
function packFoliage(
  instances: TerrainProject['foliage'],
): PackedFoliage | undefined {
  const values = new Float64Array(instances.length * 5);
  const references = new Uint32Array(instances.length * 2);
  const strings: string[] = [],
    indices = new Map<string, number>();
  const reference = (text: string) => {
    let index = indices.get(text);
    if (index === undefined) {
      index = strings.length + 1;
      indices.set(text, index);
      strings.push(text);
    }
    return index;
  };
  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i],
      keys = Object.keys(instance);
    const expected = Object.hasOwn(instance, 'modelId')
      ? modelFoliageKeys
      : foliageKeys;
    if (
      keys.length !== expected.length ||
      keys.some((key, k) => key !== expected[k]) ||
      typeof instance.brushId !== 'string' ||
      (instance.modelId !== undefined && typeof instance.modelId !== 'string')
    )
      return undefined;
    if (
      typeof instance.id !== 'number' ||
      typeof instance.x !== 'number' ||
      typeof instance.z !== 'number' ||
      typeof instance.scale !== 'number' ||
      typeof instance.rotation !== 'number'
    )
      return undefined;
    values[i * 5] = instance.id;
    values[i * 5 + 1] = instance.x;
    values[i * 5 + 2] = instance.z;
    values[i * 5 + 3] = instance.scale;
    values[i * 5 + 4] = instance.rotation;
    references[i * 2] = reference(instance.brushId);
    references[i * 2 + 1] =
      instance.modelId === undefined ? 0 : reference(instance.modelId);
  }
  return { values, references, strings };
}
function unpackFoliage(packed: PackedFoliage): TerrainProject['foliage'] {
  const { values, references, strings } = packed;
  const count = values.length / 5;
  if (
    !(values instanceof Float64Array) ||
    !(references instanceof Uint32Array) ||
    !Number.isInteger(count) ||
    count > 50000 ||
    references.length !== count * 2 ||
    !Array.isArray(strings) ||
    !strings.every((value) => typeof value === 'string')
  )
    throw new Error('Invalid packed foliage.');
  const text = (index: number) => {
    if (index < 1 || index > strings.length)
      throw new Error('Invalid packed foliage reference.');
    return strings[index - 1];
  };
  return Array.from({ length: count }, (_, i) => ({
    id: values[i * 5],
    brushId: text(references[i * 2]),
    ...(references[i * 2 + 1] ? { modelId: text(references[i * 2 + 1]) } : {}),
    x: values[i * 5 + 1],
    z: values[i * 5 + 2],
    scale: values[i * 5 + 3],
    rotation: values[i * 5 + 4],
  }));
}

export interface PackageCapture {
  foliage?: PackedFoliage;
  project: ReferenceProject;
  payloads: string[];
  transfer: ArrayBuffer[];
}
export interface PackageRequest {
  mode?: ProjectPackageMode;
  foliage?: PackedFoliage;
  id: number;
  project: ReferenceProject;
  dictionary: number[];
  added: [number, string][];
}
export type PackageResponse =
  | { id: number; type: 'result'; blob: Blob; encodeMs: number }
  | { id: number; type: 'error'; message: string };

/** Copy editable metadata/buffers once; immutable asset strings stay out of structuredClone. */
export function capturePackageProject(project: TerrainProject): PackageCapture {
  const payloads: string[] = [],
    indices = new Map<string, number>();
  const reference = (value: string) => {
    if (typeof value !== 'string') throw new Error('Invalid embedded asset.');
    let index = indices.get(value);
    if (index === undefined) {
      index = payloads.length;
      indices.set(value, index);
      payloads.push(value);
    }
    return index;
  };
  const captured = structuredClone({
    ...project,
    heights: undefined,
    holes: undefined,
    paint: undefined,
    foliage: undefined,
    assets: Object.fromEntries(
      Object.entries(project.assets).map(([key, value]) => [
        key,
        { ...value, data: reference(value.data) },
      ]),
    ),
    materials: project.materials.map((material) => ({
      ...material,
      textures: Object.fromEntries(
        Object.entries(material.textures).map(([key, value]) => [
          key,
          reference(value),
        ]),
      ),
    })),
    ...(project.environment?.image
      ? {
          environment: {
            ...project.environment,
            image: {
              ...project.environment.image,
              data: reference(project.environment.image.data),
            },
          },
        }
      : {}),
    ...(project.sculpt?.alpha
      ? {
          sculpt: {
            ...project.sculpt,
            alpha: { ...project.sculpt.alpha, values: undefined },
          },
        }
      : {}),
  }) as unknown as ReferenceProject;
  const foliage = packFoliage(project.foliage);
  captured.foliage = foliage ? [] : structuredClone(project.foliage);
  // Copy only the visible typed-array ranges, including subarray inputs.
  captured.heights = new Float32Array(project.heights);
  captured.holes = new Uint8Array(project.holes);
  captured.paint = new Float32Array(project.paint);
  const transfer = [
    captured.heights.buffer,
    captured.holes.buffer,
    captured.paint.buffer,
  ] as ArrayBuffer[];
  if (project.sculpt?.alpha) {
    const values = new Float32Array(project.sculpt.alpha.values);
    captured.sculpt!.alpha!.values = values;
    transfer.push(values.buffer);
  }
  if (foliage)
    transfer.push(
      foliage.values.buffer as ArrayBuffer,
      foliage.references.buffer as ArrayBuffer,
    );
  return { project: captured, payloads, transfer, foliage };
}

/** Lives in the worker. Only the current request's asset dictionary is retained. */
export class PackageEncodingSession {
  private payloads = new Map<number, string>();
  private writer = new ProjectPackageWriter();
  encode(request: PackageRequest): Blob {
    const candidate = new Map(this.payloads);
    for (const [id, data] of request.added) {
      if (!Number.isSafeInteger(id) || id < 0 || typeof data !== 'string')
        throw new Error('Invalid package asset dictionary.');
      candidate.set(id, data);
    }
    const keep = new Map<number, string>();
    const urls = request.dictionary.map((id) => {
      const data = candidate.get(id);
      if (data === undefined) throw new Error('Missing package asset payload.');
      keep.set(id, data);
      return data;
    });
    const asset = (index: number) => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= urls.length)
        throw new Error('Invalid package asset reference.');
      return urls[index];
    };
    const source = request.project;
    const project: TerrainProject = {
      ...source,
      foliage: request.foliage
        ? unpackFoliage(request.foliage)
        : source.foliage,
      assets: Object.fromEntries(
        Object.entries(source.assets).map(([key, value]) => [
          key,
          { ...value, data: asset(value.data) },
        ]),
      ),
      materials: source.materials.map((material) => ({
        ...material,
        textures: Object.fromEntries(
          Object.entries(material.textures).map(([key, index]) => [
            key,
            asset(index),
          ]),
        ),
      })),
      ...(source.environment
        ? {
            environment: {
              ...source.environment,
              ...(source.environment.image
                ? {
                    image: {
                      ...source.environment.image,
                      data: asset(source.environment.image.data),
                    },
                  }
                : {}),
            } as EnvironmentSettings,
          }
        : {}),
    } as TerrainProject;
    const blob = this.writer.encode(project, request.mode);
    this.payloads = keep;
    return blob;
  }
}
