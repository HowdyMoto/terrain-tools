import { WorldTileIndex } from './world';
import type {
  TerrainWorld,
  WorldPosition,
  WorldTile,
  WorldTileSelection,
} from './world';

/** Owned prepared tile. Byte counts describe retained CPU/GPU data; dispose must not throw. */
export interface WorldTileResource<T> {
  readonly value: T;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  dispose(): void;
}
export interface WorldTileSource<T> {
  /** Honor cancellation promptly and clean up partial failures. The streamer releases late results. */
  load(tile: WorldTile, signal: AbortSignal): Promise<WorldTileResource<T>>;
}
export interface WorldStreamingOptions {
  /** Horizontal view radius in metres. */
  radius: number;
  maxResidentTiles?: number;
  maxConcurrentLoads?: number;
  /** Admission limits for retained resources, excluding loader-owned temporary allocations. */
  cpuByteLimit?: number;
  gpuByteLimit?: number;
}
interface Load {
  controller: AbortController;
}

/** Bounded, renderer-independent tile residency. Does not create meshes, colliders or an editor UI.
 * Loading starts nearest-first. Failed/over-budget tiles wait for explicit retry, avoiding retry storms.
 * Aborted operations occupy their concurrency slot until settled, even if a source ignores AbortSignal.
 */
export class WorldStreamer<T> {
  private readonly index: WorldTileIndex;
  private readonly options: Required<WorldStreamingOptions>;
  private wanted = new Map<string, WorldTileSelection>();
  private readonly residents = new Map<string, WorldTileResource<T>>();
  private readonly loads = new Map<string, Load>();
  private readonly failures = new Map<string, Error>();
  private cpuBytes = 0;
  private gpuBytes = 0;
  private disposed = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    world: TerrainWorld,
    private readonly source: WorldTileSource<T>,
    options: WorldStreamingOptions,
  ) {
    this.index = new WorldTileIndex(world);
    this.options = {
      radius: options.radius,
      maxResidentTiles: options.maxResidentTiles ?? 64,
      maxConcurrentLoads: options.maxConcurrentLoads ?? 2,
      cpuByteLimit: options.cpuByteLimit ?? 256 * 1024 * 1024,
      gpuByteLimit: options.gpuByteLimit ?? 512 * 1024 * 1024,
    };
    const o = this.options;
    if (
      !Number.isFinite(o.radius) ||
      o.radius < 0 ||
      !Number.isInteger(o.maxResidentTiles) ||
      o.maxResidentTiles < 1 ||
      o.maxResidentTiles > 4096 ||
      !Number.isInteger(o.maxConcurrentLoads) ||
      o.maxConcurrentLoads < 1 ||
      o.maxConcurrentLoads > 32 ||
      ![o.cpuByteLimit, o.gpuByteLimit].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw new Error('Invalid world streaming limits.');
  }
  /** Select desired cells and evict those outside this bounded selection. */
  update(position: WorldPosition) {
    if (this.disposed) throw new Error('World streamer has been disposed.');
    const selected = this.index.select(
      position,
      this.options.radius,
      this.options.maxResidentTiles,
    );
    this.wanted = new Map(selected.map((tile) => [tile.key, tile]));
    for (const key of this.failures.keys())
      if (!this.wanted.has(key)) this.failures.delete(key);
    for (const [key, load] of this.loads)
      if (!this.wanted.has(key)) load.controller.abort();
    for (const [key, resource] of this.residents)
      if (!this.wanted.has(key)) {
        this.residents.delete(key);
        this.cpuBytes -= resource.cpuBytes;
        this.gpuBytes -= resource.gpuBytes;
        resource.dispose();
      }
    this.pump();
  }
  /** Resources are borrowed: the streamer owns disposal. Do not retain values beyond residency. */
  get(key: string) {
    return this.residents.get(key)?.value;
  }
  get residentKeys(): readonly string[] {
    return [...this.residents.keys()];
  }
  get errors(): ReadonlyMap<string, Error> {
    return new Map(this.failures);
  }
  get stats() {
    return {
      residentTiles: this.residents.size,
      loadingTiles: this.loads.size,
      queuedTiles: [...this.wanted.keys()].filter(
        (key) =>
          !this.residents.has(key) &&
          !this.loads.has(key) &&
          !this.failures.has(key),
      ).length,
      failedTiles: this.failures.size,
      cpuBytes: this.cpuBytes,
      gpuBytes: this.gpuBytes,
    };
  }
  retry(key?: string) {
    if (this.disposed) throw new Error('World streamer has been disposed.');
    if (key === undefined) this.failures.clear();
    else this.failures.delete(key);
    this.pump();
  }
  /** Resolves when current and cancelled loads have settled; inspect errors for failed cells. */
  whenIdle(): Promise<void> {
    if (!this.loads.size) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.wanted.clear();
    this.failures.clear();
    for (const load of this.loads.values()) load.controller.abort();
    for (const resource of this.residents.values()) resource.dispose();
    this.residents.clear();
    this.cpuBytes = this.gpuBytes = 0;
    this.notifyIdle();
  }
  private pump() {
    if (this.disposed) {
      this.notifyIdle();
      return;
    }
    for (const [key, selection] of this.wanted) {
      if (this.loads.size >= this.options.maxConcurrentLoads) break;
      if (
        this.loads.has(key) ||
        this.residents.has(key) ||
        this.failures.has(key)
      )
        continue;
      const load = { controller: new AbortController() };
      this.loads.set(key, load);
      void this.run(key, selection.tile, load);
    }
    this.notifyIdle();
  }
  private async run(key: string, tile: WorldTile, load: Load) {
    let resource: WorldTileResource<T> | undefined;
    try {
      // Defer source invocation so synchronous throws cannot recursively pump
      // thousands of failed cells, and an immediate teleport can cancel first.
      await Promise.resolve();
      if (load.controller.signal.aborted) return;
      resource = await this.source.load(tile, load.controller.signal);
      if (
        this.disposed ||
        load.controller.signal.aborted ||
        !this.wanted.has(key)
      )
        return;
      if (
        ![resource.cpuBytes, resource.gpuBytes].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        )
      )
        throw new Error('A tile source returned invalid resource byte counts.');
      if (
        this.cpuBytes + resource.cpuBytes > this.options.cpuByteLimit ||
        this.gpuBytes + resource.gpuBytes > this.options.gpuByteLimit
      )
        throw new Error('Tile exceeds the resident CPU/GPU byte budget.');
      const admitted = resource;
      // Capture accounting once: the source may retain its original handle.
      this.residents.set(key, {
        value: admitted.value,
        cpuBytes: admitted.cpuBytes,
        gpuBytes: admitted.gpuBytes,
        dispose: () => admitted.dispose(),
      });
      this.cpuBytes += resource.cpuBytes;
      this.gpuBytes += resource.gpuBytes;
      resource = undefined;
    } catch (error) {
      if (
        !this.disposed &&
        !load.controller.signal.aborted &&
        this.wanted.has(key)
      )
        this.failures.set(
          key,
          error instanceof Error ? error : new Error(String(error)),
        );
    } finally {
      resource?.dispose();
      this.loads.delete(key);
      this.pump();
    }
  }
  private notifyIdle() {
    if (this.loads.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
