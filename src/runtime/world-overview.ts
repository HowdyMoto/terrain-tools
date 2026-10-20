import * as THREE from 'three';
import type { TerrainProject } from '../core/types';
import type { TerrainWorld, WorldTile } from '../core/world';
import { validateTerrainWorld } from '../core/world';
import { WorldStreamer } from '../core/world-streamer';
import type { WorldStreamingOptions } from '../core/world-streamer';
import { buildTerrainOverview } from '../core/terrain-overview';
import { TerrainMaterial } from '../render/material';
import { checkSignal, yieldPreparation } from '../render/resources';
import { WorldAssets } from './world-assets';

export interface WorldOverviewOptions extends WorldStreamingOptions {
  /** Height/paint/material inputs only. Models, foliage, water and physics are ignored. */
  load(tile: WorldTile, signal: AbortSignal): Promise<TerrainProject>;
  assets?: WorldAssets;
  /** Grid stride; default targets 16 coarse cells per tile with full boundary detail. */
  step?: number;
  /** Disable texture preparation for headless geometry consumers. */
  materials?: boolean;
}

/** Independently budgeted distant terrain. Add beside a TerrainWorldScene under
 * the same parent transform; pass detailed resident keys to update(). Overview
 * cells stay ready beneath hidden detailed cells and restore on their eviction.
 * Does not supply authoritative heights, collision, foliage or distant water. */
export class TerrainWorldOverview extends THREE.Group {
  readonly world: TerrainWorld;
  readonly assets: WorldAssets;
  readonly streaming: WorldStreamer<THREE.Mesh>;
  private ownAssets: boolean;
  private covered = new Set<string>();
  private positionInWorld = new THREE.Vector3();
  private closed = false;
  constructor(
    world: TerrainWorld,
    readonly options: WorldOverviewOptions,
  ) {
    super();
    this.options = options = { ...options };
    this.world = validateTerrainWorld(world);
    this.assets = options.assets ?? new WorldAssets();
    this.ownAssets = !options.assets;
    this.streaming = new WorldStreamer(
      this.world,
      {
        load: async (tile, signal) => {
          const p = await options.load(tile, signal);
          checkSignal(signal);
          if (p.size !== this.world.tileSize)
            throw new Error('Overview tile dimensions do not match the world.');
          await yieldPreparation(signal);
          const data = buildTerrainOverview(
            p,
            options.step,
            Math.min(
              options.cpuByteLimit ?? 32 * 1024 ** 2,
              options.gpuByteLimit ?? 32 * 1024 ** 2,
            ),
          );
          const geometry = new THREE.BufferGeometry();
          const surface = new TerrainMaterial(this.assets);
          let mesh: THREE.Mesh | undefined;
          const dispose = () => {
            mesh?.removeFromParent();
            geometry.dispose();
            surface.dispose();
          };
          try {
            geometry.setAttribute(
              'position',
              new THREE.BufferAttribute(data.positions, 3),
            );
            geometry.setAttribute(
              'normal',
              new THREE.BufferAttribute(data.normals, 3),
            );
            geometry.setAttribute(
              'layerWeights',
              new THREE.BufferAttribute(data.weights, 4),
            );
            geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
            if (options.materials !== false) {
              const prepared = await surface.prepare(p, signal);
              try {
                checkSignal(signal);
                surface.apply(prepared);
              } finally {
                prepared.dispose();
              }
            }
            checkSignal(signal);
            mesh = new THREE.Mesh(geometry, surface.material);
            mesh.position.set(
              (tile.x + 0.5) * p.size,
              0,
              (tile.z + 0.5) * p.size,
            );
            mesh.receiveShadow = true;
            // Coarse terrain must not cast inaccurate kilometer-scale shadows.
            mesh.castShadow = false;
            const bytes =
              data.positions.byteLength +
              data.normals.byteLength +
              data.weights.byteLength +
              data.indices.byteLength;
            return { value: mesh, cpuBytes: bytes, gpuBytes: bytes, dispose };
          } catch (error) {
            dispose();
            throw error;
          }
        },
      },
      {
        ...options,
        maxResidentTiles: options.maxResidentTiles ?? 64,
        cpuByteLimit: options.cpuByteLimit ?? 32 * 1024 ** 2,
        gpuByteLimit: options.gpuByteLimit ?? 32 * 1024 ** 2,
      },
    );
  }
  update(camera: THREE.Camera, detailedKeys: Iterable<string> = []) {
    if (this.closed) throw new Error('World overview is disposed.');
    this.covered = new Set(detailedKeys);
    this.updateWorldMatrix(true, false);
    this.worldToLocal(camera.getWorldPosition(this.positionInWorld));
    this.streaming.update({
      x: this.positionInWorld.x,
      z: this.positionInWorld.z,
    });
    this.activate();
  }
  private activate() {
    for (const key of this.streaming.residentKeys) {
      const mesh = this.streaming.get(key)!;
      if (mesh.parent !== this) this.add(mesh);
      mesh.visible = !this.covered.has(key);
    }
  }
  async whenIdle() {
    await this.streaming.whenIdle();
    if (!this.closed) this.activate();
  }
  get stats() {
    const stats = this.streaming.stats;
    let visibleTiles = 0,
      triangles = 0;
    for (const key of this.streaming.residentKeys) {
      const mesh = this.streaming.get(key)!;
      if (mesh.visible) {
        visibleTiles++;
        triangles += (mesh.geometry.index?.count ?? 0) / 3;
      }
    }
    return { ...stats, visibleTiles, triangles };
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.streaming.dispose();
    this.covered.clear();
    this.clear();
    if (this.ownAssets) this.assets.dispose();
  }
}
