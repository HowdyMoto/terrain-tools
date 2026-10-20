import * as THREE from 'three';
import type { TerrainProject } from '../core/types';
import { heightAt as projectHeight } from '../core/terrain';
import { WorldStreamer } from '../core/world-streamer';
import type { WorldStreamingOptions } from '../core/world-streamer';
import { validateTerrainWorld, worldTileKey } from '../core/world';
import type { TerrainWorld, WorldTile } from '../core/world';
import { TerrainScene } from './terrain-scene';
import { TerrainLod } from './terrain-lod';
import type { TerrainLodOptions } from './terrain-lod';
import { WorldAssets } from './world-assets';
import { modelMemory } from './asset-memory';
import { checkSignal } from '../render/resources';
import { webOceanGPUBytes } from './web-ocean/simulation';
import { foliageMotionReservation } from '../render/native-foliage';
import { TerrainPreparer, yieldPreparation } from './terrain-preparer';

export interface WorldColliders {
  /** Prepared colliders remain disabled until their rendered tile is admitted. */
  activate(): void;
  dispose(): void;
  cpuBytes: number;
}
export interface WorldCollisionSource {
  prepare(terrain: TerrainScene, signal: AbortSignal): Promise<WorldColliders>;
}
export interface WorldSceneOptions extends WorldStreamingOptions {
  load(tile: WorldTile, signal: AbortSignal): Promise<TerrainProject>;
  assets?: WorldAssets;
  collision?: WorldCollisionSource;
  lod?: TerrainLodOptions | false;
  /** For hosts preparing geometry without browser texture decoding. */
  materials?: boolean;
  /** Browser workers prepare immutable grid/normals/LOD data; main-thread fallback remains available. */
  terrainPreparation?: 'worker' | 'main';
  foliageClusters?:
    boolean | import('./foliage-clusters').FoliageClusterOptions;
  /** Optional staged shader/upload warmup. Resolves before residency/collision activation. */
  prepareGPU?: (terrain: TerrainScene, signal: AbortSignal) => Promise<void>;
}
interface TileView {
  descriptor: WorldTile;
  terrain: TerrainScene;
  lod?: TerrainLod;
  collision?: WorldColliders;
}

/** Stream authored terrains into one host scene with shared assets and full-resolution collision.
 * Tile projects are immutable while resident. Coordinates are metres in the manifest's XZ space.
 * Set this group's position for a host-managed floating origin; queries remain in manifest space.
 */
export class TerrainWorldScene extends THREE.Group {
  readonly world: TerrainWorld;
  readonly assets: WorldAssets;
  readonly streaming: WorldStreamer<TileView>;
  private readonly ownAssets: boolean;
  private active = new Map<string, TileView>();
  private viewPosition = new THREE.Vector3();
  private elapsed = 0;
  private closed = false;
  private seamsDirty = false;
  private preparer?: TerrainPreparer;
  /** Last 256 preparation durations; includes payload, texture/model decode and terrain work. */
  readonly loadMilliseconds: number[] = [];
  constructor(
    world: TerrainWorld,
    readonly options: WorldSceneOptions,
  ) {
    super();
    this.world = validateTerrainWorld(world);
    this.assets = options.assets ?? new WorldAssets();
    this.ownAssets = !options.assets;
    if (options.terrainPreparation !== 'main' && typeof Worker !== 'undefined')
      this.preparer = new TerrainPreparer(
        Math.min(8, options.maxConcurrentLoads ?? 2),
      );
    this.streaming = new WorldStreamer(
      this.world,
      {
        load: async (descriptor, signal) => {
          const started = performance.now();
          const p = await options.load(descriptor, signal);
          checkSignal(signal);
          if (
            p.size !== this.world.tileSize ||
            p.heights.length !== (p.resolution + 1) ** 2
          )
            throw new Error('World tile dimensions do not match the manifest.');
          const data = await this.preparer?.prepare(
            p,
            signal,
            options.lod !== false,
          );
          checkSignal(signal);
          const terrain = new TerrainScene(p, {
            assets: this.assets,
            preparedTerrain: data,
            yieldPreparation: this.preparer ? yieldPreparation : undefined,
            foliageClusters: options.foliageClusters,
          });
          let lod: TerrainLod | undefined,
            collision: WorldColliders | undefined;
          const dispose = () => {
            this.active.delete(worldTileKey(descriptor.x, descriptor.z));
            this.seamsDirty = true;
            terrain.removeFromParent();
            collision?.dispose();
            lod?.dispose();
            terrain.dispose();
          };
          try {
            if (!(await terrain.load(p, options.materials !== false, signal)))
              throw new DOMException('Tile cancelled.', 'AbortError');
            checkSignal(signal);
            terrain.position.set(
              (descriptor.x + 0.5) * p.size,
              0,
              (descriptor.z + 0.5) * p.size,
            );
            terrain.updateMatrixWorld(true);
            terrain.waterSystem.setWorldTile(
              terrain.position.x,
              terrain.position.z,
              this,
            );
            if (options.lod !== false) {
              lod = new TerrainLod(terrain, options.lod);
              terrain.add(lod);
            }
            if (options.prepareGPU) await options.prepareGPU(terrain, signal);
            checkSignal(signal);
            if (options.collision)
              collision = await options.collision.prepare(terrain, signal);
            checkSignal(signal);
            const parts: Parameters<typeof modelMemory>[0] = [];
            terrain.traverse((object) => {
              if (object instanceof THREE.Mesh)
                parts.push({
                  geometry: object.geometry,
                  material: object.material,
                  matrix: object.matrix,
                });
            });
            const measured = modelMemory(parts);
            const canopyBytes = terrain.canopyLighting.field?.memoryBytes ?? 0;
            let instanceBytes = 0,
              motionCPUBytes = 0,
              motionGPUBytes = 0;
            terrain.traverse((object) => {
              if (object instanceof THREE.InstancedMesh) {
                instanceBytes +=
                  object.instanceMatrix.array.byteLength +
                  (object.instanceColor?.array.byteLength ?? 0);
                const motion = foliageMotionReservation(object);
                motionCPUBytes += motion.cpuBytes;
                motionGPUBytes += motion.gpuBytes;
              }
            });
            // Conservative per-tile accounting also includes shared visible mesh buffers;
            // registry counters separately report unique imported assets/surface arrays.
            const waterBytes = p.water
              ? (p.water.bodies.length + 1) * 2 * 1024 ** 2 +
                (p.resolution + 1) ** 2 * 32
              : 0;
            this.loadMilliseconds.push(performance.now() - started);
            if (this.loadMilliseconds.length > 256)
              this.loadMilliseconds.shift();
            return {
              value: { descriptor, terrain, lod, collision },
              cpuBytes:
                measured.cpuBytes +
                canopyBytes +
                motionCPUBytes +
                instanceBytes +
                (lod?.memoryBytes.cpuBytes ?? 0) +
                waterBytes +
                p.heights.byteLength +
                p.holes.byteLength +
                p.paint.byteLength +
                (collision?.cpuBytes ?? 0),
              gpuBytes:
                measured.gpuBytes +
                canopyBytes +
                motionGPUBytes +
                instanceBytes +
                (lod?.memoryBytes.gpuBytes ?? 0) +
                waterBytes +
                (p.water?.ocean.enabled &&
                p.water.ocean.renderer === 'web-ocean'
                  ? webOceanGPUBytes(
                      p.water.ocean.spectral?.quality ?? 'balanced',
                    )
                  : 0),
              dispose,
            };
          } catch (error) {
            dispose();
            throw error;
          }
        },
      },
      options,
    );
  }
  /** Load/unload around the camera, admit completed cells, then update foliage and terrain detail. */
  update(camera: THREE.Camera, dt: number, heightPixels = 1080) {
    if (this.closed) throw new Error('World scene is disposed.');
    if (!Number.isFinite(dt) || dt < 0) throw new Error('Invalid world delta.');
    this.elapsed += Math.min(dt, 0.1);
    this.updateWorldMatrix(true, false);
    this.worldToLocal(camera.getWorldPosition(this.viewPosition));
    this.streaming.update({ x: this.viewPosition.x, z: this.viewPosition.z });
    this.activate();
    for (const tile of this.active.values()) {
      tile.terrain.waterSystem.setTime(
        Math.max(0, this.elapsed - Math.min(dt, 0.1)),
      );
      tile.terrain.update(dt, [], camera);
      tile.lod?.update(camera, heightPixels, dt);
    }
  }
  /** Wait for loads and activate without advancing simulation; useful for teleports/tests. */
  async whenIdle() {
    await this.streaming.whenIdle();
    if (!this.closed) this.activate();
  }
  private activate() {
    for (const key of this.streaming.residentKeys)
      if (!this.active.has(key)) {
        const tile = this.streaming.get(key)!;
        try {
          this.validateEdges(tile);
          tile.collision?.activate();
          this.add(tile.terrain);
          this.active.set(key, tile);
          this.seamsDirty = true;
        } catch (error) {
          this.streaming.reject(
            key,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    if (this.seamsDirty) {
      this.refreshNormals();
      this.seamsDirty = false;
    }
  }
  private validateEdges(tile: TileView) {
    const p = tile.terrain.project,
      { x, z } = tile.descriptor,
      n = p.resolution;
    for (const [dx, dz] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const neighbor = this.active.get(worldTileKey(x + dx, z + dz))?.terrain
        .project;
      if (!neighbor) continue;
      if (neighbor.resolution !== n)
        throw new Error(
          'Adjacent tiles require matching authoritative height grids.',
        );
      for (let i = 0; i <= n; i++) {
        const a = dx
          ? i * (n + 1) + (dx < 0 ? 0 : n)
          : (dz < 0 ? 0 : n) * (n + 1) + i;
        const b = dx
          ? i * (n + 1) + (dx < 0 ? n : 0)
          : (dz < 0 ? n : 0) * (n + 1) + i;
        if (Math.abs(p.heights[a] - neighbor.heights[b]) > 0.0001)
          throw new Error('Adjacent tile height edges do not match.');
      }
    }
  }
  private refreshNormals() {
    const normal = new THREE.Vector3();
    for (const { terrain, descriptor } of this.active.values()) {
      const p = terrain.project,
        spacing = p.size / p.resolution;
      const ox = (descriptor.x + 0.5) * p.size,
        oz = (descriptor.z + 0.5) * p.size;
      const sample = (x: number, z: number) =>
        this.heightAt(x + ox, z + oz) ?? projectHeight(p, x, z);
      for (const mesh of terrain.terrain.children as THREE.Mesh[]) {
        const positions = mesh.geometry.getAttribute('position'),
          normals = mesh.geometry.getAttribute('normal');
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i),
            z = positions.getZ(i);
          // Interior normals already use the complete tile heightfield. Only
          // the outer vertex ring depends on streamed neighbor data.
          if (
            Math.abs(x) < p.size / 2 - spacing * 0.5 &&
            Math.abs(z) < p.size / 2 - spacing * 0.5
          )
            continue;
          normal
            .set(
              sample(x - spacing, z) - sample(x + spacing, z),
              2 * spacing,
              sample(x, z - spacing) - sample(x, z + spacing),
            )
            .normalize();
          normals.setXYZ(i, normal.x, normal.y, normal.z);
        }
        normals.needsUpdate = true;
      }
    }
  }
  /** Authoritative full-resolution height; undefined means the cell is not resident. */
  heightAt(x: number, z: number): number | undefined {
    const size = this.world.tileSize,
      tx = Math.floor(x / size),
      tz = Math.floor(z / size);
    const tile = this.active.get(worldTileKey(tx, tz));
    return tile
      ? projectHeight(
          tile.terrain.project,
          x - (tx + 0.5) * size,
          z - (tz + 0.5) * size,
        )
      : undefined;
  }
  get tiles(): readonly TerrainScene[] {
    return [...this.active.values()].map((tile) => tile.terrain);
  }
  get stats() {
    return {
      ...this.streaming.stats,
      assets: this.assets.stats,
      selectedTerrainTriangles: [...this.active.values()].reduce(
        (sum, tile) =>
          sum +
          (tile.lod?.stats.triangles ??
            tile.terrain.terrain.children.reduce(
              (n, m) => n + ((m as THREE.Mesh).geometry.index?.count ?? 0) / 3,
              0,
            )),
        0,
      ),
      fullTerrainTriangles: [...this.active.values()].reduce(
        (sum, tile) =>
          sum +
          (tile.lod?.stats.fullTriangles ??
            tile.terrain.terrain.children.reduce(
              (n, m) => n + ((m as THREE.Mesh).geometry.index?.count ?? 0) / 3,
              0,
            )),
        0,
      ),
    };
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.streaming.dispose();
    this.preparer?.dispose();
    this.active.clear();
    this.clear();
    if (this.ownAssets) this.assets.dispose();
  }
}
