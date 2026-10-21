import type { WebGPURenderer } from 'three/webgpu';

interface ProgramState {
  usedTimes: number;
  vertexShader: string;
  fragmentShader: string;
  computeShader?: string;
}

/** Three r186 removes its generated node program as soon as its last draw is
 * retired. A teleport can retire every draw before replacement tiles arrive.
 * Retain a bounded LRU of unused generated programs; active draws keep Three's
 * normal reference counts. This cache does not own geometry, textures or GPU pipelines. */
export class RetainedShaderCache extends Map<number, ProgramState> {
  private unused = new Map<number, number>();
  private eligible = new Set<number>();
  private bytes = 0;
  hits = 0;
  constructor(
    readonly maxPrograms = 64,
    readonly maxBytes = 8 * 1024 ** 2,
  ) {
    super();
    if (
      !Number.isSafeInteger(maxPrograms) ||
      maxPrograms < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0
    )
      throw new Error('Invalid generated shader cache budget.');
  }
  allow(key: number) {
    this.eligible.add(key);
  }
  override get(key: number) {
    const value = super.get(key);
    if (value && this.unused.has(key)) {
      this.hits++;
      this.forget(key);
    }
    return value;
  }
  override set(key: number, value: ProgramState) {
    this.forget(key);
    return super.set(key, value);
  }
  override delete(key: number) {
    const value = super.get(key);
    if (!value) return false;
    if (value.usedTimes !== 0 || !this.eligible.has(key)) {
      this.eligible.delete(key);
      this.forget(key);
      return super.delete(key);
    }
    this.forget(key);
    const bytes =
      ((value.vertexShader?.length ?? 0) +
        (value.fragmentShader?.length ?? 0) +
        (value.computeShader?.length ?? 0)) *
      2;
    this.unused.set(key, bytes);
    this.bytes += bytes;
    while (this.unused.size > this.maxPrograms || this.bytes > this.maxBytes) {
      const oldest = this.unused.keys().next().value!;
      this.forget(oldest);
      this.eligible.delete(oldest);
      super.delete(oldest);
    }
    return !super.has(key);
  }
  private forget(key: number) {
    const bytes = this.unused.get(key);
    if (bytes !== undefined) {
      this.bytes -= bytes;
      this.unused.delete(key);
    }
  }
  override clear() {
    this.eligible.clear();
    this.unused.clear();
    this.bytes = 0;
    super.clear();
  }
  get stats() {
    return {
      programs: this.size,
      retainedPrograms: this.unused.size,
      retainedSourceBytes: this.bytes,
      hits: this.hits,
    };
  }
}

const caches = new WeakMap<WebGPURenderer, RetainedShaderCache>();
/** Version-specific NodeManager adapter, isolated from the public scene API. */
export function installShaderRetention(renderer: WebGPURenderer) {
  if (caches.has(renderer)) return;
  const manager = (
    renderer as unknown as {
      _nodes: {
        nodeBuilderCache: Map<number, ProgramState>;
        getForRender(
          object: {
            initialCacheKey: number;
            geometry: { hasAttribute(name: string): boolean };
            material: Record<string, unknown>;
          },
          async?: boolean,
        ): unknown;
      };
    }
  )._nodes;
  const cache = new RetainedShaderCache();
  for (const [key, value] of manager.nodeBuilderCache) cache.set(key, value);
  manager.nodeBuilderCache = cache;
  const build = manager.getForRender;
  manager.getForRender = function (object, async) {
    // Only our reusable, draw-relative runtime graphs are eligible. Transient
    // bake/third-party graphs can close over large source buffers or textures.
    if (
      object.geometry.hasAttribute('terrainInstance0') ||
      object.geometry.hasAttribute('terrainLodTarget') ||
      object.material.terrainSurfaceUniforms ||
      object.material.terrainWaterUniforms
    )
      cache.allow(object.initialCacheKey);
    return build.call(this, object, async);
  };
  caches.set(renderer, cache);
  const dispose = renderer.dispose;
  renderer.dispose = function () {
    try {
      return dispose.call(this);
    } finally {
      cache.clear();
    }
  };
}
export function shaderCacheStats(renderer: WebGPURenderer) {
  return caches.get(renderer)?.stats;
}
