import {
  DataArrayTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  Vector2,
} from 'three';
import type { IUniform, Texture } from 'three';
import { StorageArrayTexture } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { gpuDevice } from '../../render/renderer';
import { defaultSpectralOceanSettings } from '../../core/water';
import type { WaterSettings } from '../../core/water';
import { webOceanShaders } from './shaders';

export const oceanPatchSizes = [
  1103, 211.3, 39.7, 7.43, 1.393, 0.2617,
] as const;
const empty = new DataArrayTexture(new Uint16Array(24), 1, 1, 6);
empty.type = HalfFloatType;
empty.needsUpdate = true;
export interface OceanBindings {
  displacement: IUniform<Texture>;
  derivatives: IUniform<Texture>;
  moments: IUniform<Texture>;
  foam: IUniform<Texture>;
  center: IUniform<Vector2>;
  whitecaps: IUniform<number>;
  resolution: IUniform<number>;
}
type Config = ReturnType<typeof configuration>;
function configuration(water: WaterSettings, windDirection: number) {
  const s = water.ocean.surface;
  return {
    ...defaultSpectralOceanSettings(),
    ...water.ocean.spectral,
    direction: s.windLinked ? windDirection : s.direction,
    swellHeight: s.swellHeight,
    swellLength: s.swellLength,
    // Different animation rates must not advance the same shared foam history.
    animationSpeed: s.speed,
  };
}
interface Shared {
  simulation: OceanSimulation;
  users: number;
}
const caches = new WeakMap<
  WebGPURenderer,
  WeakMap<object, Map<string, Shared>>
>();
const live = new WeakMap<WebGPURenderer, Set<OceanSimulation>>();
/** Raw compute buffers are owned here; Three owns and reports storage textures. */
export function webOceanResources(renderer: WebGPURenderer) {
  const simulations = live.get(renderer);
  return {
    simulations: simulations?.size ?? 0,
    bufferBytes: [...(simulations ?? [])].reduce(
      (sum, s) => sum + s.bufferBytes,
      0,
    ),
  };
}
/** Conservative per-tile reservation; synchronized tiles can share these bytes. */
export function webOceanGPUBytes(quality: 'balanced' | 'high') {
  const n = quality === 'high' ? 256 : 128,
    foam = quality === 'high' ? 1024 : 256;
  const texels = (size: number) => (size * size * 4 - 1) / 3;
  return 5 * n * n * 6 * 16 + 368 + (3 * 6 * texels(n) + 4 * texels(foam)) * 8;
}

/** A prepared water candidate leases a simulation only when GPU preparation
 * succeeds. World tiles can explicitly share one clock/scope; independent
 * scenes retain their own clocks and foam history. */
export class WebOcean {
  readonly bindings: OceanBindings = {
    displacement: { value: empty },
    derivatives: { value: empty },
    moments: { value: empty },
    foam: { value: empty },
    center: { value: new Vector2() },
    whitecaps: { value: 0 },
    resolution: { value: 128 },
  };
  private lease?: {
    renderer: WebGPURenderer;
    scope: object;
    key: string;
    map: Map<string, Shared>;
    shared: Shared;
  };
  private closed = false;
  private water?: WaterSettings;
  private direction?: number;
  ensure(
    renderer: WebGPURenderer,
    scope: object,
    water: WaterSettings,
    wind: number,
  ) {
    if (this.closed) throw new Error('Ocean simulation has been disposed.');
    const effectiveDirection = water.ocean.surface.windLinked
      ? wind
      : water.ocean.surface.direction;
    if (
      this.lease?.renderer === renderer &&
      this.lease.scope === scope &&
      this.water === water &&
      this.direction === effectiveDirection
    )
      return this.lease.shared.simulation;
    const config = configuration(water, wind),
      key = JSON.stringify(config);
    if (
      this.lease?.renderer === renderer &&
      this.lease.scope === scope &&
      this.lease.key === key
    ) {
      this.water = water;
      this.direction = effectiveDirection;
      return this.lease.shared.simulation;
    }
    let scopes = caches.get(renderer);
    if (!scopes) caches.set(renderer, (scopes = new WeakMap()));
    let map = scopes.get(scope);
    if (!map) scopes.set(scope, (map = new Map()));
    let shared = map.get(key);
    if (!shared) {
      const simulation = new OceanSimulation(renderer, config);
      shared = { simulation, users: 0 };
      map.set(key, shared);
    }
    shared.users++;
    this.release();
    this.lease = { renderer, scope, key, map, shared };
    this.water = water;
    this.direction = effectiveDirection;
    this.bindings.displacement.value = shared.simulation.displacement;
    this.bindings.derivatives.value = shared.simulation.derivatives;
    this.bindings.moments.value = shared.simulation.moments;
    this.bindings.whitecaps.value = config.whitecaps;
    this.bindings.resolution.value = config.quality === 'high' ? 256 : 128;
    this.sync();
    return shared.simulation;
  }
  step(time: number, x: number, z: number) {
    this.lease?.shared.simulation.step(time, x, z);
    this.sync();
  }
  private sync() {
    const sim = this.lease?.shared.simulation;
    if (!sim) return;
    this.bindings.foam.value = sim.foam[sim.foamIndex];
    this.bindings.center.value.copy(sim.center);
  }
  private release() {
    const lease = this.lease;
    this.lease = undefined;
    if (lease && --lease.shared.users === 0) {
      lease.map.delete(lease.key);
      lease.shared.simulation.dispose();
    }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.release();
  }
}

class OceanSimulation {
  readonly displacement: StorageArrayTexture;
  readonly derivatives: StorageArrayTexture;
  readonly moments: StorageArrayTexture;
  readonly foam: StorageArrayTexture[] = [];
  readonly center = new Vector2();
  readonly bufferBytes: number;
  foamIndex = 0;
  private readonly n: 128 | 256;
  private readonly foamSize: 256 | 1024;
  private readonly textures: StorageArrayTexture[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private readonly pipelines: GPUComputePipeline[] = [];
  private readonly groups: GPUBindGroup[] = [];
  private readonly mipGroups: GPUBindGroup[] = [];
  private readonly foamGroups: GPUBindGroup[] = [];
  private readonly foamMips: GPUBindGroup[][] = [[], []];
  private readonly sim = new Float32Array(56);
  private readonly foamData = new ArrayBuffer(144);
  private readonly foamF = new Float32Array(this.foamData);
  private readonly foamI = new Int32Array(this.foamData);
  private readonly previousSnap = new Int32Array(4);
  private readonly device: GPUDevice;
  private lastTime?: number;
  private first = true;
  private disposed = false;

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly config: Config,
  ) {
    this.device = gpuDevice(renderer);
    this.n = config.quality === 'high' ? 256 : 128;
    this.foamSize = config.quality === 'high' ? 1024 : 256;
    const specBytes = this.n * this.n * 6 * 16;
    this.bufferBytes = specBytes * 5 + 224 + 144;
    const buffer = (
      size: number,
      usage: GPUBufferUsageFlags,
      label: string,
    ) => {
      const value = this.device.createBuffer({
        size,
        usage,
        label: 'web-ocean ' + label,
      });
      this.buffers.push(value);
      return { buffer: value };
    };
    const texture = (size: number, layers: number) => {
      const value = new StorageArrayTexture(size, size, layers);
      this.textures.push(value);
      value.type = HalfFloatType;
      value.magFilter = LinearFilter;
      value.minFilter = LinearMipmapLinearFilter;
      value.wrapS = value.wrapT = RepeatWrapping;
      value.generateMipmaps = true;
      Object.assign(value, { mipmapsAutoUpdate: false });
      value.needsUpdate = true;
      renderer.initTexture(value);
      return value;
    };
    try {
      const ubo = buffer(
        224,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        'spectrum parameters',
      );
      const storage = Array.from({ length: 5 }, (_, i) =>
        buffer(specBytes, GPUBufferUsage.STORAGE, 'spectrum ' + i),
      );
      const foamUbo = buffer(
        144,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        'foam parameters',
      );
      this.displacement = texture(this.n, 6);
      this.derivatives = texture(this.n, 6);
      this.moments = texture(this.n, 6);
      this.foam.push(texture(this.foamSize, 2), texture(this.foamSize, 2));
      const shaders = webOceanShaders(this.n, this.foamSize);
      for (const [label, code] of Object.entries(shaders))
        this.pipelines.push(
          this.device.createComputePipeline({
            label: 'web-ocean ' + label,
            layout: 'auto',
            compute: {
              module: this.device.createShaderModule({ code }),
              entryPoint: 'main',
            },
          }),
        );
      const group = (index: number, resources: GPUBindingResource[]) =>
        this.device.createBindGroup({
          layout: this.pipelines[index].getBindGroupLayout(0),
          entries: resources.map((resource, binding) => ({
            resource,
            binding,
          })),
        });
      const view = (texture: StorageArrayTexture, mip?: number) => {
        // Renderer-local adapter for pinned Three r186 storage textures.
        const native = (
          renderer.backend as unknown as {
            get(t: Texture): { texture: GPUTexture };
          }
        ).get(texture).texture;
        if (!native)
          throw new Error('Spectral ocean texture allocation failed.');
        return native.createView({
          dimension: '2d-array',
          ...(mip === undefined ? {} : { baseMipLevel: mip, mipLevelCount: 1 }),
        });
      };
      this.groups.push(
        group(0, [ubo, storage[0]]),
        group(1, [ubo, storage[0], storage[1], storage[2]]),
        group(2, [storage[1], storage[2], storage[3], storage[4]]),
        group(3, [
          storage[3],
          storage[4],
          ...this.textures.slice(0, 3).map((t) => view(t, 0)),
        ]),
      );
      for (let m = 1; m <= Math.log2(this.n); m++)
        this.mipGroups.push(
          group(4, [
            ...this.textures.slice(0, 3).map((t) => view(t, m - 1)),
            ...this.textures.slice(0, 3).map((t) => view(t, m)),
          ]),
        );
      const sampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      });
      for (let i = 0; i < 2; i++) {
        this.foamGroups.push(
          group(5, [
            foamUbo,
            view(this.foam[1 - i], 0),
            view(this.foam[i], 0),
            view(this.displacement),
            view(this.derivatives),
            sampler,
            sampler,
          ]),
        );
        for (let m = 1; m <= Math.log2(this.foamSize); m++)
          this.foamMips[i].push(
            group(6, [view(this.foam[i], m - 1), view(this.foam[i], m)]),
          );
      }
      this.writeSpectrum();
      this.step(0, 0, 0);
      let set = live.get(renderer);
      if (!set) live.set(renderer, (set = new Set()));
      set.add(this);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private writeSpectrum() {
    const s = this.sim,
      c = this.config;
    for (let i = 0; i < 6; i++) {
      s[i] = oceanPatchSizes[i];
      s[16 + i] =
        i < 5
          ? (2 * Math.PI * 6) / oceanPatchSizes[i + 1]
          : ((Math.PI * this.n) / oceanPatchSizes[i]) * 0.98;
      s[8 + i] = i === 0 ? Math.PI / oceanPatchSizes[i] : s[16 + i - 1];
    }
    s[40] = c.windSpeed;
    s[41] = (c.direction * Math.PI) / 180;
    s[42] = c.fetch;
    s[43] = 3.3;
    s[44] = c.swellHeight;
    s[45] = (c.swellDirection * Math.PI) / 180;
    s[46] = Math.sqrt((9.81 * 2 * Math.PI) / c.swellLength);
    s[47] = 24;
    s[48] = c.choppiness;
    s[49] = 0.0012;
    s[50] = 600;
    s[51] = c.seed;
    s[54] = 2.2;
    s[55] = 1;
  }
  step(time: number, x: number, z: number) {
    if (this.disposed) throw new Error('Ocean simulation has been disposed.');
    if (
      time === this.lastTime &&
      Math.abs(x - this.center.x) < 0.01 &&
      Math.abs(z - this.center.y) < 0.01
    )
      return;
    const first = this.lastTime === undefined;
    const dt = Math.min(0.1, Math.max(0, time - (this.lastTime ?? time)));
    if (this.lastTime !== undefined && Math.abs(time - this.lastTime) > 0.5)
      this.first = true;
    this.lastTime = time;
    this.center.set(x, z);
    this.sim[52] = time % 600;
    this.sim[53] = dt;
    this.device.queue.writeBuffer(this.buffers[0], 0, this.sim);
    const f = this.foamF,
      ints = this.foamI;
    for (let l = 0; l < 2; l++) {
      const texel = [128, 1024][l] / this.foamSize;
      const cx = Math.floor(x / texel),
        cz = Math.floor(z / texel);
      ints[l * 4] = cx;
      ints[l * 4 + 1] = cz;
      ints[l * 4 + 2] = this.first ? cx + 100000 : this.previousSnap[l * 2];
      ints[l * 4 + 3] = this.first ? cz + 100000 : this.previousSnap[l * 2 + 1];
      this.previousSnap[l * 2] = cx;
      this.previousSnap[l * 2 + 1] = cz;
      f[8 + l] = texel;
    }
    this.first = false;
    f[10] = dt;
    f[11] = 0.22;
    f[12] = 0.52 + 0.16 * this.config.whitecaps;
    f[13] = 2;
    f[14] = 1;
    for (let i = 0; i < 6; i++) {
      f[16 + i] = oceanPatchSizes[i];
      f[24 + i] = 1 / oceanPatchSizes[i];
    }
    f[32] = Math.cos(this.sim[41]) * 0.03 * this.config.windSpeed;
    f[33] = Math.sin(this.sim[41]) * 0.03 * this.config.windSpeed;
    this.device.queue.writeBuffer(this.buffers[6], 0, this.foamData);
    const encoder = this.device.createCommandEncoder({
      label: 'web-ocean simulation',
    });
    const pass = encoder.beginComputePass();
    const dispatch = (
      index: number,
      group: GPUBindGroup,
      a: number,
      b = 1,
      c = 1,
    ) => {
      pass.setPipeline(this.pipelines[index]);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(a, b, c);
    };
    if (first) dispatch(0, this.groups[0], this.n / 16, this.n / 16, 6);
    dispatch(1, this.groups[1], this.n / 16, this.n / 16, 6);
    dispatch(2, this.groups[2], this.n, 1, 6);
    dispatch(3, this.groups[3], this.n, 1, 6);
    this.mipGroups.forEach((group, i) =>
      dispatch(
        4,
        group,
        Math.ceil((this.n >> (i + 1)) / 8),
        Math.ceil((this.n >> (i + 1)) / 8),
        6,
      ),
    );
    this.foamIndex = 1 - this.foamIndex;
    dispatch(
      5,
      this.foamGroups[this.foamIndex],
      this.foamSize / 8,
      this.foamSize / 8,
      2,
    );
    this.foamMips[this.foamIndex].forEach((group, i) =>
      dispatch(
        6,
        group,
        Math.ceil((this.foamSize >> (i + 1)) / 8),
        Math.ceil((this.foamSize >> (i + 1)) / 8),
        2,
      ),
    );
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of this.buffers) buffer.destroy();
    for (const texture of this.textures) texture.dispose();
    live.get(this.renderer)?.delete(this);
  }
}
