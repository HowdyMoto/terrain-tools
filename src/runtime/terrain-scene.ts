import * as THREE from 'three';
import { EditTransaction } from '../render/edit-transaction';
import { TerrainWater, prepareWaterTerrain } from './water';
import type { PreparedWater } from './water';
import { buildMeshData, effectiveHoles, heightAt } from '../core/terrain';
import type { PreparedTerrainData } from '../core/terrain-preparation';
import { rememberPreparedTerrain } from './terrain-preparer';
import { CanopyLighting } from './canopy-lighting';
import type { PreparedCanopy } from './canopy-lighting';
import type { TerrainProject } from '../core/types';
import { TerrainFoliage } from './foliage';
import type { PreparedFoliage } from './foliage';
import type { GroundContact } from '../core/interaction';
import { TerrainMaterial } from '../render/material';
import { ModelLibrary } from '../render/models';
import type { WorldAssets } from './world-assets';
import type { PreparedModels } from '../render/models';
import type { PreparedMaterial } from '../render/material';
import {
  PreparedResource,
  checkSignal,
  linkedController,
  cancelled,
} from '../render/resources';

export type { TerrainRegion } from '../core/types';
import type { TerrainRegion } from '../core/types';
export interface CollisionMesh {
  positions: Float32Array;
  indices: Uint32Array;
}
interface TerrainGeometry {
  water: ReturnType<typeof prepareWaterTerrain>;
  waterPreview: boolean;
  region?: TerrainRegion;
  project: TerrainProject;
  /** Detached candidate meshes, suitable for preparing picking/collision data. */
  meshes: THREE.Mesh[];
  chunks: Map<string, THREE.Mesh>;
  changes: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }[];
  changed: THREE.Mesh[];
  retired: THREE.BufferGeometry[];
  full: boolean;
  revision: number;
}
export type PreparedTerrainGeometry = PreparedResource<TerrainGeometry>;
interface TerrainResources {
  canopy: PreparedCanopy;
  water: PreparedWater;
  project: TerrainProject;
  models: PreparedModels;
  material?: PreparedMaterial;
  geometry: PreparedTerrainGeometry;
  foliage: PreparedFoliage;
  props: THREE.Group;
}
export type PreparedTerrain = PreparedResource<TerrainResources>;
/** Render a complete authored terrain in an application's existing Three.js scene. */
export class TerrainScene extends THREE.Group {
  readonly canopyLighting: CanopyLighting;
  readonly terrain = new THREE.Group();
  readonly foliage: TerrainFoliage;
  readonly props = new THREE.Group();
  readonly library: ModelLibrary;
  readonly terrainMaterial: TerrainMaterial;
  readonly water: THREE.Mesh;
  readonly waterSystem: TerrainWater;
  private chunks = new Map<string, THREE.Mesh>();
  private disposed = false;
  private geometryRevision = 0;
  private edit?: EditTransaction;
  private retainedGeometry?: Set<THREE.BufferGeometry>;
  private loading?: AbortController;
  private requests = new Set<AbortController>();
  private terrainData?: PreparedTerrainData;
  project: TerrainProject;
  constructor(
    project: TerrainProject,
    private options: {
      assets?: WorldAssets;
      decoder?: import('../render/model-loader').ModelDecoder;
      preparedTerrain?: PreparedTerrainData;
      yieldPreparation?: (signal: AbortSignal) => Promise<void>;
      foliageClusters?:
        boolean | import('./foliage-clusters').FoliageClusterOptions;
    } = {},
  ) {
    super();
    this.library = new ModelLibrary(
      options.assets?.decode ?? options.decoder,
      !!options.assets,
    );
    this.terrainMaterial = new TerrainMaterial(options.assets);
    this.waterSystem = new TerrainWater(
      this.terrainMaterial.material,
      this.terrainMaterial.shoreUniforms,
    );
    this.name = project.name;
    this.project = project;
    this.terrainData = options.preparedTerrain;
    this.options = { ...options, preparedTerrain: undefined };
    this.foliage = new TerrainFoliage(project, this.library, {
      distantClusters: options.foliageClusters,
    });
    this.canopyLighting = new CanopyLighting(
      this,
      () => this.project,
      this.library,
      () => !!this.edit,
    );
    this.foliage.onPopulationChanged = () => this.canopyLighting.invalidate();
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({
        color: '#527c7b',
        roughness: 0.24,
        metalness: 0.25,
        transparent: true,
        opacity: 0.76,
        side: THREE.DoubleSide,
      }),
    );
    this.water.name = 'Water';
    this.water.rotation.x = -Math.PI / 2;
    this.terrain.name = 'Terrain';
    this.foliage.name = 'Foliage';
    this.props.name = 'Props';
    this.add(
      this.terrain,
      this.foliage,
      this.props,
      this.water,
      this.waterSystem,
    );
  }
  /** Stage assets, surface maps and scene geometry without touching the visible terrain. Do not mutate project until committed. */
  async prepareLoad(
    project = this.project,
    materials = true,
    signal?: AbortSignal,
  ): Promise<PreparedTerrain> {
    if (this.disposed) throw new Error('Terrain scene has been disposed.');
    if (this.edit)
      throw new Error(
        'Finish the active geometry edit before loading a project.',
      );
    const { controller, unlink } = linkedController(signal);
    this.requests.add(controller);
    let models: PreparedModels | undefined,
      material: PreparedMaterial | undefined,
      geometry: PreparedTerrainGeometry | undefined,
      foliage: PreparedFoliage | undefined;
    let water: PreparedWater | undefined;
    let canopy: PreparedCanopy | undefined;
    const release = () => {
      water?.dispose();
      geometry?.dispose();
      foliage?.dispose();
      models?.dispose();
      material?.dispose();
      canopy?.dispose();
    };
    controller.signal.addEventListener('abort', release, { once: true });
    try {
      models = await this.library.prepareAssets(project, controller.signal);
      checkSignal(controller.signal);
      if (materials)
        material = await this.terrainMaterial.prepare(
          project,
          controller.signal,
        );
      checkSignal(controller.signal);
      await this.options.yieldPreparation?.(controller.signal);
      geometry = this.prepareTerrain(undefined, project);
      await this.options.yieldPreparation?.(controller.signal);
      foliage = this.foliage.prepare(project, models);
      await this.options.yieldPreparation?.(controller.signal);
      const props = this.prepareProps(project, models);
      canopy = await this.canopyLighting.prepare(
        project,
        project.environment,
        models,
        controller.signal,
      );
      water = this.waterSystem.prepare(
        project,
        project.water
          ? await this.options.assets?.foam(controller.signal)
          : undefined,
      );
      checkSignal(controller.signal);
      return new PreparedResource(
        this,
        { project, models, material, geometry, foliage, props, water, canopy },
        release,
      );
    } catch (error) {
      release();
      throw error;
    } finally {
      controller.signal.removeEventListener('abort', release);
      this.requests.delete(controller);
      unlink();
    }
  }
  /** Commit only after all preparation and caller revision checks have succeeded. */
  assertPrepared(prepared: PreparedTerrain) {
    if (this.disposed) throw new Error('Terrain scene has been disposed.');
    prepared.assert(this);
    const state = prepared.value;
    state.water.assert(this.waterSystem);
    this.library.assertPrepared(state.models);
    this.assertTerrain(state.geometry);
    state.foliage.assert(this.foliage);
    if (state.material) this.terrainMaterial.assertPrepared(state.material);
    state.canopy.assert(this.canopyLighting);
  }
  applyPrepared(prepared: PreparedTerrain) {
    this.assertPrepared(prepared);
    const state = prepared.value;
    this.loading?.abort();
    prepared.take(this);
    this.library.apply(state.models);
    if (state.material) this.terrainMaterial.apply(state.material);
    this.project = state.project;
    this.name = state.project.name;
    this.waterSystem.apply(state.water);
    this.applyTerrain(state.geometry);
    this.foliage.apply(state.foliage);
    this.applyProps(state.props);
    this.canopyLighting.apply(state.canopy);
  }
  /** Latest request wins. Failed or cancelled preparation retains the current scene. */
  async load(project = this.project, materials = true, signal?: AbortSignal) {
    this.loading?.abort();
    const { controller, unlink } = linkedController(signal);
    this.loading = controller;
    let prepared: PreparedTerrain | undefined;
    try {
      prepared = await this.prepareLoad(project, materials, controller.signal);
      checkSignal(controller.signal);
      if (this.loading !== controller) throw cancelled();
      this.loading = undefined;
      this.applyPrepared(prepared);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      throw error;
    } finally {
      prepared?.dispose();
      if (this.loading === controller) this.loading = undefined;
      unlink();
    }
  }
  /** A two-sample halo covers normals and slope-dependent material rules.
   * waterPreview requires beginEdit(); call finalizeWaterPreview() before history
   * and commit, or roll back. Terrain dimensions and water settings must stay fixed.
   */
  prepareTerrain(
    region?: TerrainRegion,
    p = this.project,
    options: { waterPreview?: boolean } = {},
  ): PreparedTerrainGeometry {
    if (this.disposed) throw new Error('Terrain scene has been disposed.');
    if (options.waterPreview && !this.edit)
      throw new Error(
        'Deferred water preparation requires an active geometry edit.',
      );
    const holes = effectiveHoles(p),
      chunk = 32,
      spacing = p.size / p.resolution;
    const meshes: THREE.Mesh[] = [],
      changed: THREE.Mesh[] = [],
      changes: TerrainGeometry['changes'] = [],
      chunks = region ? new Map(this.chunks) : new Map<string, THREE.Mesh>(),
      retired = region
        ? []
        : [...this.chunks.values()].map((mesh) => mesh.geometry),
      owned = new Set<THREE.BufferGeometry>();
    const preparedChunks =
      !region && p === this.project && this.terrainData
        ? new Map(
            this.terrainData.chunks.map((chunk) => [
              chunk.x + ',' + chunk.z,
              chunk,
            ]),
          )
        : undefined;
    const release = () => {
      for (const geometry of owned) geometry.dispose();
      owned.clear();
    };
    try {
      for (let z = 0; z < p.resolution; z += chunk)
        for (let x = 0; x < p.resolution; x += chunk) {
          const nx = Math.min(chunk, p.resolution - x),
            nz = Math.min(chunk, p.resolution - z);
          const minX = x * spacing - p.size / 2,
            maxX = (x + nx) * spacing - p.size / 2,
            minZ = z * spacing - p.size / 2,
            maxZ = (z + nz) * spacing - p.size / 2;
          if (
            region &&
            (maxX < region.minX - 2 * spacing ||
              minX > region.maxX + 2 * spacing ||
              maxZ < region.minZ - 2 * spacing ||
              minZ > region.maxZ + 2 * spacing)
          )
            continue;
          const precomputed = preparedChunks?.get(x + ',' + z);
          if (
            preparedChunks &&
            (!precomputed ||
              precomputed.nx !== nx ||
              precomputed.nz !== nz ||
              precomputed.positions.length !== (nx + 1) * (nz + 1) * 3 ||
              precomputed.normals.length !== precomputed.positions.length)
          )
            throw new Error('Invalid prepared terrain chunks.');
          const data = precomputed ?? buildMeshData(p, x, z, nx, nz, holes),
            geometry = new THREE.BufferGeometry();
          owned.add(geometry);
          geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(data.positions, 3),
          );
          geometry.setAttribute(
            'layerWeights',
            new THREE.BufferAttribute(data.weights, 4),
          );
          geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
          const normals =
            precomputed?.normals ?? new Float32Array(data.positions.length);
          for (let i = 0; !precomputed && i < data.positions.length; i += 3) {
            const px = data.positions[i],
              pz = data.positions[i + 2];
            new THREE.Vector3(
              heightAt(p, px - spacing, pz) - heightAt(p, px + spacing, pz),
              2 * spacing,
              heightAt(p, px, pz - spacing) - heightAt(p, px, pz + spacing),
            )
              .normalize()
              .toArray(normals, i);
          }
          geometry.setAttribute(
            'normal',
            new THREE.BufferAttribute(normals, 3),
          );
          if (precomputed) {
            geometry.boundingBox = new THREE.Box3(
              new THREE.Vector3().fromArray(precomputed.bounds, 0),
              new THREE.Vector3().fromArray(precomputed.bounds, 3),
            );
            geometry.boundingSphere = new THREE.Sphere(
              new THREE.Vector3().fromArray(precomputed.sphere),
              precomputed.sphere[3],
            );
          } else {
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
          }
          const key = x + ',' + z,
            candidate = new THREE.Mesh(geometry, this.terrainMaterial.material);
          candidate.name = 'Terrain ' + key;
          candidate.receiveShadow = candidate.castShadow = true;
          candidate.userData = { chunkX: x, chunkZ: z, cellsX: nx, cellsZ: nz };
          if (precomputed) rememberPreparedTerrain(geometry, precomputed);
          meshes.push(candidate);
          const existing = region ? this.chunks.get(key) : undefined;
          if (existing) {
            changes.push({ mesh: existing, geometry });
            retired.push(existing.geometry);
          }
          const mesh = existing ?? candidate;
          chunks.set(key, mesh);
          changed.push(mesh);
        }
      return new PreparedResource(
        this,
        {
          project: p,
          water: options.waterPreview ? undefined : prepareWaterTerrain(p),
          waterPreview: !!options.waterPreview,
          region,
          meshes,
          chunks,
          changes,
          changed,
          retired,
          full: !region,
          revision: this.geometryRevision,
        },
        release,
      );
    } catch (error) {
      release();
      throw error;
    }
  }
  assertTerrain(prepared: PreparedTerrainGeometry) {
    if (this.disposed) throw new Error('Terrain scene has been disposed.');
    prepared.assert(this);
    if (prepared.value.revision !== this.geometryRevision)
      throw new Error(
        'Prepared terrain is stale; prepare it again after editing.',
      );
  }
  applyTerrain(prepared: PreparedTerrainGeometry) {
    this.assertTerrain(prepared);
    const state = prepared.take(this),
      p = state.project;
    this.geometryRevision++;
    this.terrainData = undefined;
    this.canopyLighting.invalidate();
    for (const { mesh, geometry } of state.changes) mesh.geometry = geometry;
    this.chunks = state.chunks;
    if (state.full) this.terrain.clear();
    for (const mesh of this.chunks.values())
      if (mesh.parent !== this.terrain) this.terrain.add(mesh);
    for (const geometry of state.retired)
      if (!this.retainedGeometry?.has(geometry)) geometry.dispose();
    this.updateTerrainView(p);
    if (state.waterPreview)
      this.waterSystem.previewTerrainHeights(p, state.region);
    else this.waterSystem.applyTerrain(state.water);
    return state.changed;
  }
  /** Resolve deferred water topology before history/checkpoint and edit.commit().
   * Can throw (for example, a basin spill); the active edit remains rollback-capable.
   */
  finalizeWaterPreview() {
    if (!this.edit)
      throw new Error('Water preview requires an active geometry edit.');
    this.waterSystem.applyTerrain(prepareWaterTerrain(this.project));
  }
  /** Apply water and terrain shading flags after editing project.view; retain all scene geometry. */
  refreshView() {
    if (this.disposed) throw new Error('Terrain scene has been disposed.');
    this.updateTerrainView(this.project);
  }
  private updateTerrainView(p: TerrainProject) {
    this.water.scale.set(p.size, p.size, 1);
    this.water.position.y = p.view.waterLevel;
    this.water.visible = !p.water && p.view.water;
    this.waterSystem.visible = !!p.water;
    if (this.terrainMaterial.material.flatShading !== p.view.lowPoly) {
      this.terrainMaterial.material.flatShading = p.view.lowPoly;
      this.terrainMaterial.material.needsUpdate = true;
    }
    this.terrainMaterial.material.wireframe = p.view.wireframe;
  }
  /** Preview an independent geometry-only candidate. Keep assets and surface resources unchanged. */
  beginEdit(candidate: TerrainProject): EditTransaction {
    if (this.disposed || this.edit)
      throw new Error('A geometry edit cannot start now.');
    if (candidate === this.project)
      throw new Error('Use an independent project for a geometry edit.');
    const project = this.project,
      waterBefore =
        this.waterSystem.snapshotTerrain() ?? prepareWaterTerrain(this.project),
      chunks = this.chunks,
      geometries = new Map(
        [...chunks].map(([key, mesh]) => [key, mesh.geometry]),
      ),
      retained = new Set(geometries.values()),
      props = [...this.props.children],
      candidateProps = this.prepareProps(candidate);
    const foliage = this.foliage.beginEdit(candidate);
    this.retainedGeometry = retained;
    this.project = candidate;
    this.applyProps(candidateProps);
    this.geometryRevision++;
    const finish = () => {
      this.retainedGeometry = undefined;
      this.edit = undefined;
      this.geometryRevision++;
      this.canopyLighting.invalidate();
    };
    const edit = new EditTransaction(
      () => {
        finish();
        for (const [key, geometry] of geometries)
          if (this.chunks.get(key)?.geometry !== geometry) geometry.dispose();
        foliage.commit();
      },
      () => {
        for (const mesh of this.chunks.values())
          if (!retained.has(mesh.geometry)) mesh.geometry.dispose();
        for (const [key, mesh] of chunks) mesh.geometry = geometries.get(key)!;
        this.chunks = chunks;
        this.terrain.clear();
        for (const mesh of chunks.values()) this.terrain.add(mesh);
        this.props.clear();
        for (const prop of props) this.props.add(prop);
        foliage.rollback();
        this.project = project;
        this.updateTerrainView(project);
        this.waterSystem.applyTerrain(waterBefore);
        finish();
      },
    );
    this.edit = edit;
    return edit;
  }
  /** Replace every affected chunk together; a failed allocation retains all current chunks. */
  rebuildTerrain(region?: TerrainRegion) {
    const prepared = this.prepareTerrain(region);
    try {
      return this.applyTerrain(prepared);
    } finally {
      prepared.dispose();
    }
  }
  rebuildFoliage() {
    this.foliage.rebuild(this.project);
  }
  private prepareProps(project = this.project, models?: PreparedModels) {
    const group = new THREE.Group();
    for (const prop of project.props) {
      const object = this.library.object(prop.model, models);
      object.name = prop.model + ' ' + prop.id;
      object.position.set(
        prop.x,
        heightAt(project, prop.x, prop.z) + prop.yOffset,
        prop.z,
      );
      object.rotation.y = prop.rotation;
      object.scale.setScalar(prop.scale);
      object.userData = {
        propId: prop.id,
        cutHole: prop.cutHole,
        holeRadius: prop.holeRadius,
      };
      group.add(object);
    }
    return group;
  }
  private applyProps(group: THREE.Group) {
    this.props.clear();
    while (group.children.length) this.props.add(group.children[0]);
  }
  rebuildProps() {
    this.applyProps(this.prepareProps());
  }
  /** Extract candidate prop triangles before committing scene or physics state. */
  preparedPropCollision(prepared: PreparedTerrain): CollisionMesh[] {
    prepared.assert(this);
    this.updateWorldMatrix(true, false);
    const group = prepared.value.props;
    group.matrix.copy(this.matrixWorld);
    group.matrixAutoUpdate = false;
    return extractCollisionMeshes(group);
  }
  reanchorFoliage(region: TerrainRegion) {
    this.foliage.reanchor(region);
    this.canopyLighting.invalidate();
  }
  reanchorProps(region: TerrainRegion) {
    const pad = (2 * this.project.size) / this.project.resolution;
    let changed = false;
    for (const object of this.props.children) {
      if (
        object.position.x < region.minX - pad ||
        object.position.x > region.maxX + pad ||
        object.position.z < region.minZ - pad ||
        object.position.z > region.maxZ + pad
      )
        continue;
      const prop = this.project.props.find(
        (p) => p.id === object.userData.propId,
      );
      if (!prop) continue;
      const y = heightAt(this.project, prop.x, prop.z) + prop.yOffset;
      if (y !== object.position.y) {
        object.position.y = y;
        changed = true;
      }
    }
    return changed;
  }
  /** dt is seconds; contact positions and radii use this terrain's local metres. */
  update(dt: number, contacts: GroundContact[] = [], camera?: THREE.Camera) {
    if (!Number.isFinite(dt) || dt < 0)
      throw new Error('Terrain update requires a non-negative time delta.');
    this.foliage.update(dt, contacts, camera);
    this.waterSystem.update(dt, camera, this.project);
    this.canopyLighting.updateTransform();
  }
  clearInteractions() {
    this.foliage.clearInteractions();
  }
  /** Static terrain/prop triangle soup in world space, suitable for other engines. */
  collisionMeshes(includeProps = true, includeTerrain = true): CollisionMesh[] {
    this.updateWorldMatrix(true, true);
    return [
      ...(includeTerrain ? extractCollisionMeshes(this.terrain) : []),
      ...(includeProps ? extractCollisionMeshes(this.props) : []),
    ];
  }
  dispose() {
    this.canopyLighting.dispose();
    if (this.disposed) return;
    this.edit?.rollback();
    this.disposed = true;
    this.loading?.abort();
    this.requests.forEach((controller) => controller.abort());
    for (const mesh of this.chunks.values()) mesh.geometry.dispose();
    this.chunks.clear();
    this.foliage.dispose();
    this.library.dispose();
    this.terrainMaterial.dispose();
    this.waterSystem.dispose();
    this.water.geometry.dispose();
    (this.water.material as THREE.Material).dispose();
    this.clear();
  }
}

function extractCollisionMeshes(root: THREE.Object3D): CollisionMesh[] {
  root.updateWorldMatrix(true, true);
  const meshes: CollisionMesh[] = [];
  const extract = (object: THREE.Object3D) => {
    if (!(object instanceof THREE.Mesh)) return;
    const source = object.geometry.getAttribute('position');
    if (!source) return;
    const positions = new Float32Array(source.count * 3),
      v = new THREE.Vector3();
    for (let i = 0; i < source.count; i++)
      v.fromBufferAttribute(source, i)
        .applyMatrix4(object.matrixWorld)
        .toArray(positions, i * 3);
    const sourceIndex = object.geometry.index;
    const indices = sourceIndex
      ? Uint32Array.from(sourceIndex.array)
      : Uint32Array.from({ length: source.count }, (_, i) => i);
    if (indices.length) meshes.push({ positions, indices });
  };
  root.traverse(extract);
  return meshes;
}
