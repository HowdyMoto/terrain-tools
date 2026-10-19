import type { TerrainProject, TerrainRegion } from '../core/types';
import { buildMeshData, effectiveHoles } from '../core/terrain';
import RAPIER from '@dimforge/rapier3d-compat';
import { PreparedResource } from '../render/resources';
import type { WorldCollisionSource } from '../runtime/world-scene';
interface ColliderReplacement {
  revision: number;
  terrain?: Map<string, RAPIER.Collider>;
  handles?: Set<number>;
  props?: RAPIER.Collider[];
  created: RAPIER.Collider[];
  retired: RAPIER.Collider[];
}
export type PreparedColliders = PreparedResource<ColliderReplacement>;
export class TerrainPhysics {
  world!: RAPIER.World;
  private disposed = false;
  private revision = 0;
  private pending = new Set<PreparedColliders>();
  private terrain = new Map<string, RAPIER.Collider>();
  private terrainHandles = new Set<number>();
  private accumulator = 0;
  private propColliders: RAPIER.Collider[] = [];
  async init() {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
  }
  /** Disabled candidates cannot collide while the live world continues stepping. */
  prepare(
    p?: TerrainProject,
    region?: TerrainRegion,
    meshes?: { positions: Float32Array; indices: Uint32Array }[],
  ): PreparedColliders {
    if (this.disposed || !this.world)
      throw new Error('Terrain physics is unavailable.');
    const created: RAPIER.Collider[] = [],
      retired: RAPIER.Collider[] = [];
    let terrain: Map<string, RAPIER.Collider> | undefined,
      handles: Set<number> | undefined,
      props: RAPIER.Collider[] | undefined;
    let prepared: PreparedColliders | undefined;
    const release = () => {
      if (prepared) this.pending.delete(prepared);
      for (const collider of created)
        this.world.removeCollider(collider, false);
      created.length = 0;
    };
    const create = (
      positions: Float32Array,
      indices: Uint32Array,
      flags?: RAPIER.TriMeshFlags,
    ) => {
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.trimesh(positions, indices, flags)
          .setFriction(0.85)
          .setEnabled(false),
      );
      created.push(collider);
      return collider;
    };
    try {
      if (p) {
        terrain = region ? new Map(this.terrain) : new Map();
        handles = region ? new Set(this.terrainHandles) : new Set();
        if (!region) retired.push(...this.terrain.values());
        const holes = effectiveHoles(p),
          chunk = 32,
          step = p.size / p.resolution;
        for (let z = 0; z < p.resolution; z += chunk)
          for (let x = 0; x < p.resolution; x += chunk) {
            const nx = Math.min(chunk, p.resolution - x),
              nz = Math.min(chunk, p.resolution - z);
            if (
              region &&
              ((x + nx) * step - p.size / 2 < region.minX - step ||
                x * step - p.size / 2 > region.maxX + step ||
                (z + nz) * step - p.size / 2 < region.minZ - step ||
                z * step - p.size / 2 > region.maxZ + step)
            )
              continue;
            const key = x + ',' + z,
              old = terrain.get(key);
            if (old) {
              retired.push(old);
              handles.delete(old.handle);
              terrain.delete(key);
            }
            const data = buildMeshData(p, x, z, nx, nz, holes, false);
            if (data.indices.length) {
              // Adjacent triangle edges must not kick a resting body sideways on a flat surface.
              const collider = create(
                data.positions,
                data.indices,
                RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
              );
              terrain.set(key, collider);
              handles.add(collider.handle);
            }
          }
      }
      if (meshes) {
        props = [];
        retired.push(...this.propColliders);
        for (const mesh of meshes)
          if (mesh.indices.length)
            props.push(create(mesh.positions, mesh.indices));
      }
      prepared = new PreparedResource(
        this,
        { terrain, handles, props, created, retired, revision: this.revision },
        release,
      );
      this.pending.add(prepared);
      return prepared;
    } catch (error) {
      release();
      throw error;
    }
  }
  assertPrepared(prepared: PreparedColliders) {
    if (this.disposed) throw new Error('Terrain physics has been disposed.');
    prepared.assert(this);
    if (prepared.value.revision !== this.revision)
      throw new Error(
        'Prepared collision is stale; prepare it again after editing.',
      );
  }
  apply(prepared: PreparedColliders) {
    this.assertPrepared(prepared);
    const state = prepared.take(this);
    this.revision++;
    this.pending.delete(prepared);
    for (const collider of state.created) collider.setEnabled(true);
    if (state.terrain) this.terrain = state.terrain;
    if (state.handles) this.terrainHandles = state.handles;
    if (state.props) this.propColliders = state.props;
    for (const collider of state.retired)
      this.world.removeCollider(collider, true);
  }
  rebuild(p: TerrainProject, region?: TerrainRegion) {
    const prepared = this.prepare(p, region);
    try {
      this.apply(prepared);
    } finally {
      prepared.dispose();
    }
  }
  setPropMeshes(meshes: { positions: Float32Array; indices: Uint32Array }[]) {
    const prepared = this.prepare(undefined, undefined, meshes);
    try {
      this.apply(prepared);
    } finally {
      prepared.dispose();
    }
  }
  drop(x: number, y: number, z: number, radius = 1) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setCcdEnabled(true),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(radius)
        .setDensity(2)
        .setRestitution(0.18)
        .setFriction(0.7),
      body,
    );
    return body;
  }
  touchesTerrain(body: RAPIER.RigidBody) {
    let touching = false;
    for (let i = 0; i < body.numColliders(); i++) {
      const collider = body.collider(i);
      this.world.contactPairsWith(collider, (other) => {
        if (!this.terrainHandles.has(other.handle)) return;
        this.world.contactPair(collider, other, (manifold) => {
          for (let j = 0; j < manifold.numContacts(); j++)
            if (manifold.contactDist(j) <= 0.05) touching = true;
        });
      });
    }
    return touching;
  }
  step(dt: number) {
    this.accumulator += Math.min(dt, 0.1);
    while (this.accumulator >= 1 / 60) {
      this.world.step();
      this.accumulator -= 1 / 60;
    }
  }
  remove(body: RAPIER.RigidBody) {
    this.world.removeRigidBody(body);
  }
  dispose() {
    if (this.disposed) return;
    for (const prepared of this.pending) prepared.dispose();
    this.disposed = true;
    this.terrain.clear();
    this.terrainHandles.clear();
    this.propColliders = [];
    this.world?.free();
  }
}

/** Optional streamed collider adapter for an already initialized host Rapier world.
 * The host owns stepping and world disposal. Dispose streamed terrain first and
 * await its idle promise before freeing the Rapier world.
 */
export function createWorldCollisionSource(
  world: RAPIER.World,
): WorldCollisionSource {
  return {
    async prepare(terrain, signal) {
      const created: RAPIER.Collider[] = [];
      let active = false,
        disposed = false,
        cpuBytes = 0;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const collider of created) world.removeCollider(collider, true);
      };
      try {
        for (const mesh of terrain.collisionMeshes()) {
          if (signal.aborted)
            throw new DOMException(
              'Collider preparation cancelled.',
              'AbortError',
            );
          const collider = world.createCollider(
            RAPIER.ColliderDesc.trimesh(
              mesh.positions,
              mesh.indices,
              RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
            )
              .setFriction(0.85)
              .setEnabled(false),
          );
          created.push(collider);
          // Estimate mesh/BVH retained WASM storage separately from source buffers.
          cpuBytes += (mesh.positions.byteLength + mesh.indices.byteLength) * 3;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        if (signal.aborted)
          throw new DOMException(
            'Collider preparation cancelled.',
            'AbortError',
          );
        return {
          cpuBytes,
          dispose,
          activate() {
            if (disposed)
              throw new Error('Prepared world colliders are unavailable.');
            if (active) return;
            for (const collider of created) collider.setEnabled(true);
            active = true;
          },
        };
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}
