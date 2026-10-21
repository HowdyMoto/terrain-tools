import * as THREE from 'three';
import { setCanopyBinding } from '../render/canopy-binding';
import type { TerrainProject } from '../core/types';
import type { EnvironmentSettings } from '../core/environment';
import { foliageModel } from '../core/foliage';
import { heightAt, effectiveHoles, isHole } from '../core/terrain';
import { terrainPreparationInput } from '../core/terrain-preparation';
import { bakeCanopyLight } from '../core/canopy-lighting';
import type {
  CanopyLightInput,
  CanopyLightData,
} from '../core/canopy-lighting';
import type { ModelLibrary, PreparedModels } from '../render/models';
import { PreparedResource, checkSignal, cancelled } from '../render/resources';
import { isWebGPU, validateGPU } from '../render/renderer';
import type { TerrainRenderer } from '../render/renderer';

export class CanopyLightField {
  readonly texture: THREE.Data3DTexture;
  readonly groundTexture: THREE.DataTexture;
  readonly groundRange: THREE.Vector2;
  readonly minimum: THREE.Vector3;
  readonly inverseSize: THREE.Vector3;
  readonly worldToLocal = new THREE.Matrix4();
  readonly worldToField = new THREE.Matrix4();
  readonly normalizedGroundRange: THREE.Vector2;
  readonly localToField: THREE.Matrix4;
  /** Owned texture payload bytes; excludes driver and JavaScript bookkeeping. */
  get memoryBytes() {
    return (
      (this.texture.image.data?.byteLength ?? 0) +
      (this.groundTexture.image.data?.byteLength ?? 0)
    );
  }
  constructor(
    readonly key: string,
    data: CanopyLightData,
  ) {
    const pixels = Uint16Array.from(data.pixels, (value) =>
      THREE.DataUtils.toHalfFloat(value),
    );
    this.texture = new THREE.Data3DTexture(pixels, ...data.dimensions);
    this.texture.type = THREE.HalfFloatType;
    this.texture.format = THREE.RGBAFormat;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.unpackAlignment = 1;
    this.texture.name = 'Terrain canopy light field';
    this.texture.needsUpdate = true;
    this.groundTexture = new THREE.DataTexture(
      Uint16Array.from(data.ground, (value) =>
        THREE.DataUtils.toHalfFloat(value),
      ),
      data.dimensions[0],
      data.dimensions[2],
      THREE.RedFormat,
      THREE.HalfFloatType,
    );
    this.groundTexture.minFilter = this.groundTexture.magFilter =
      THREE.LinearFilter;
    this.groundTexture.name = 'Terrain canopy ground heights';
    this.groundTexture.needsUpdate = true;
    this.groundRange = new THREE.Vector2(...data.groundRange);
    this.minimum = new THREE.Vector3(...data.minimum);
    this.inverseSize = new THREE.Vector3(1, 1, 1).divide(
      new THREE.Vector3(...data.size),
    );
    this.normalizedGroundRange = this.groundRange
      .clone()
      .multiplyScalar(this.inverseSize.y);
    this.localToField = new THREE.Matrix4()
      .makeScale(...this.inverseSize.toArray())
      .multiply(
        new THREE.Matrix4().makeTranslation(
          -this.minimum.x,
          -this.minimum.y,
          -this.minimum.z,
        ),
      );
  }
  dispose() {
    this.texture.dispose();
    this.groundTexture.dispose();
  }
}
export type PreparedCanopy = PreparedResource<CanopyLightField | undefined>;

function inputFor(
  project: TerrainProject,
  library: ModelLibrary,
  models?: PreparedModels,
): CanopyLightInput {
  const brushes = new Map(project.brushes.map((brush) => [brush.id, brush]));
  const occluders: CanopyLightInput['occluders'] = [];
  const bounds = new Map<string, THREE.Box3>();
  const holes = effectiveHoles(project);
  for (const instance of project.foliage) {
    if (isHole(project, instance.x, instance.z, holes)) continue;
    const brush = brushes.get(instance.brushId),
      model = brush && foliageModel(brush, instance);
    if (!model) continue;
    let box = bounds.get(model.model);
    if (!box) {
      box = library.bounds(model.model, models);
      bounds.set(model.model, box);
    }
    const height = (box.max.y - box.min.y) * instance.scale;
    if (height < 2.5) continue;
    const cx = ((box.min.x + box.max.x) / 2) * instance.scale,
      cz = ((box.min.z + box.max.z) / 2) * instance.scale,
      cosine = Math.cos(instance.rotation),
      sine = Math.sin(instance.rotation);
    occluders.push({
      x: instance.x + cx * cosine + cz * sine,
      y:
        heightAt(project, instance.x, instance.z) +
        box.min.y * instance.scale +
        height * 0.7,
      z: instance.z - cx * sine + cz * cosine,
      rx: Math.max(0.25, (box.max.x - box.min.x) * instance.scale * 0.45),
      ry: Math.max(0.25, height * 0.3),
      rz: Math.max(0.25, (box.max.z - box.min.z) * instance.scale * 0.45),
      rotation: instance.rotation,
    });
  }
  return {
    project: terrainPreparationInput(project),
    occluders,
    colors: project.materials.map((material) => {
      const color = new THREE.Color(
        material.color.toLowerCase() === '#ffffff'
          ? (project.environment?.groundColor ?? '#677950')
          : material.color,
      );
      return [color.r, color.g, color.b];
    }),
  };
}
function keyFor(input: CanopyLightInput) {
  let first = 2166136261,
    second = 0x9e3779b9;
  const metadata = new TextEncoder().encode(
    JSON.stringify([
      input.project.size,
      input.project.resolution,
      input.occluders,
      input.colors,
      input.project.materials.map(
        ({ minHeight, maxHeight, minSlope, maxSlope, feather }) => [
          minHeight,
          maxHeight,
          minSlope,
          maxSlope,
          feather,
        ],
      ),
    ]),
  );
  for (const bytes of [
    metadata,
    new Uint8Array(
      input.project.heights.buffer,
      input.project.heights.byteOffset,
      input.project.heights.byteLength,
    ),
    new Uint8Array(
      input.project.paint.buffer,
      input.project.paint.byteOffset,
      input.project.paint.byteLength,
    ),
  ])
    for (const byte of bytes) {
      first = Math.imul(first ^ byte, 16777619);
      second = Math.imul(second ^ byte, 0x85ebca6b);
    }
  return (first >>> 0).toString(16) + ':' + (second >>> 0).toString(16);
}
async function prepareData(input: CanopyLightInput, signal?: AbortSignal) {
  checkSignal(signal);
  if (typeof Worker === 'undefined') return bakeCanopyLight(input);
  return new Promise<CanopyLightData>((resolve, reject) => {
    const worker = new Worker(
      new URL('./terrain-preparation.worker.ts', import.meta.url),
      { type: 'module' },
    );
    const done = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const fail = (error: Error) => {
      done();
      reject(error);
    };
    const abort = () => fail(cancelled());
    const timeout = setTimeout(
      () => fail(new Error('Canopy light preparation timed out.')),
      120000,
    );
    worker.onmessage = (event) => {
      done();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.data);
    };
    worker.onerror = (event) =>
      fail(new Error(event.message || 'Canopy worker failed.'));
    worker.onmessageerror = () =>
      fail(new Error('Invalid canopy worker reply.'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      worker.postMessage({ id: 0, kind: 'canopy', input }, [
        input.project.heights.buffer,
        input.project.paint.buffer,
        input.project.holes.buffer,
      ]);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Bakes before adoption, debounces committed edits, and rejects obsolete work.
 * Painting/sculpt previews retain the existing field until the edit is settled. */
export class CanopyLighting {
  field?: CanopyLightField;
  readonly binding: { field?: CanopyLightField } = {};
  error?: Error;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private revision = 0;
  private closed = false;
  private renderer?: TerrainRenderer;
  constructor(
    private root: THREE.Group,
    private project: () => TerrainProject,
    private library: ModelLibrary,
    private editing: () => boolean,
  ) {
    setCanopyBinding(root, this.binding);
  }
  async prepare(
    project: TerrainProject,
    settings: EnvironmentSettings | undefined = project.environment,
    models?: PreparedModels,
    signal?: AbortSignal,
  ): Promise<PreparedCanopy> {
    checkSignal(signal);
    if (this.closed) throw new Error('Canopy lighting is disposed.');
    if (!settings?.canopyLighting?.enabled)
      return new PreparedResource(this, undefined, () => {});
    const input = inputFor(
      { ...project, environment: settings },
      this.library,
      models,
    );
    if (!input.occluders.length)
      return new PreparedResource(this, undefined, () => {});
    const key = keyFor(input);
    if (this.field?.key === key)
      return new PreparedResource(this, this.field, () => {});
    const data = await prepareData(input, signal);
    checkSignal(signal);
    const field = new CanopyLightField(key, data);
    return new PreparedResource(this, field, () => field.dispose());
  }
  async prepareGPU(prepared: PreparedCanopy, renderer: TerrainRenderer) {
    prepared.assert(this);
    this.renderer = renderer;
    if (prepared.value) {
      if (!isWebGPU(renderer))
        throw new Error('Canopy lighting requires native WebGPU.');
      await validateGPU(renderer, () => {
        renderer.initTexture(prepared.value!.texture);
        renderer.initTexture(prepared.value!.groundTexture);
      });
    }
  }
  apply(prepared: PreparedCanopy) {
    const field = prepared.take(this),
      old = this.field;
    this.revision++;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.field = field;
    this.binding.field = field;
    this.error = undefined;
    this.bind();
    this.updateTransform();
    if (old !== field) old?.dispose();
  }
  bind() {
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) setCanopyBinding(object, this.binding);
    });
  }
  updateTransform() {
    if (this.field) {
      this.root.updateWorldMatrix(true, false);
      this.field.worldToLocal.copy(this.root.matrixWorld).invert();
      this.field.worldToField.multiplyMatrices(
        this.field.localToField,
        this.field.worldToLocal,
      );
    }
  }
  invalidate() {
    if (this.closed) return;
    const ticket = ++this.revision;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.bind();
    if (!this.project().environment?.canopyLighting?.enabled) return;
    this.timer = setTimeout(() => {
      if (this.editing()) {
        this.invalidate();
        return;
      }
      const controller = (this.controller = new AbortController());
      void this.prepare(this.project(), undefined, undefined, controller.signal)
        .then(async (prepared) => {
          try {
            if (this.renderer) await this.prepareGPU(prepared, this.renderer);
            if (this.closed || ticket !== this.revision) return;
            this.apply(prepared);
          } finally {
            prepared.dispose();
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted && !this.closed)
            this.error =
              error instanceof Error ? error : new Error(String(error));
        });
    }, 250);
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.revision++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.field?.dispose();
    this.field = undefined;
    this.binding.field = undefined;
    this.bind();
  }
}
