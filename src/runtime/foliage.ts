import * as THREE from 'three';
import { configureImpostorMaterial } from './foliage-impostor';
import type { FoliageImpostor } from './foliage-impostor';
import { configureFoliageSubsurface } from './foliage-shading';
import { EditTransaction } from '../render/edit-transaction';
import { effectiveHoles, heightAt, isHole } from '../core/terrain';
import { foliageModel } from '../core/foliage';
import {
  foliageDensityRank,
  foliageDistanceLevel,
  FoliageLodTransitions,
} from '../core/foliage-lod';
import { configureFoliageFade, FOLIAGE_FADE_ATTRIBUTE } from './foliage-fade';
import { FoliageInteraction } from '../core/interaction';
import { FoliageDrawClusters } from './foliage-clusters';
import type { FoliageClusterOptions } from './foliage-clusters';
import type { GroundContact } from '../core/interaction';
import type {
  FoliageInstance,
  FoliageModel,
  TerrainProject,
  TerrainRegion,
} from '../core/types';
import type { ModelLibrary, ModelPart, PreparedModels } from '../render/models';
import { registerFoliageBatch } from '../render/native-foliage';
import { PreparedResource, checkSignal } from '../render/resources';
export type PreparedFoliage = PreparedResource<TerrainFoliage>;
export interface FoliageRenderOptions {
  distantClusters?: boolean | FoliageClusterOptions;
  /** Replaces only the last authored LOD; primary geometry and exports remain complete. */
  impostors?: ReadonlyMap<string, FoliageImpostor>;
  lazyInstances?: boolean;
}
import { configureWind, windUniforms, shadowMaterials } from './wind';
import {
  prepareFlexibility,
  foliageGeometryView,
  CONTACT_SHADER_ATTRIBUTE,
  FLEXIBILITY_SHADER_ATTRIBUTE,
} from '../render/foliage-flexibility';

interface BatchMaterials {
  color: THREE.Material | THREE.Material[];
  depth: THREE.MeshDepthMaterial;
  distance: THREE.MeshDistanceMaterial;
}
interface Batch {
  capacity: number;
  baseGeometry: THREE.BufferGeometry;
  contact?: THREE.InstancedBufferAttribute;
  fade?: THREE.InstancedBufferAttribute;
  radius: number;
  mesh: THREE.InstancedMesh;
  level: number;
  /** Source instance index to the packed draw-buffer index; -1 means not drawn. */
  slots: Int32Array;
}
interface Tile {
  instances: FoliageInstance[];
  model: FoliageModel;
  matrices: Float32Array;
  contacts: Float32Array;
  root?: number;
  ranks: Float64Array;
  selected: Int8Array;
  drawn: Int8Array;
  transitions?: FoliageLodTransitions;
  visibleCount: number;
  batches: Batch[];
  counts: number[];
  camera: THREE.Vector3;
  /** Minimum camera travel that could cross any instance’s next hysteresis threshold. */
  guard: number;
}
export interface FoliageViewStats {
  /** After distance/density selection, before the renderer's frustum culling. */
  instances: number;
  culled: number;
  batches: number;
  triangles: number;
  /** Unique plants currently cross-fading, including appearance/disappearance. */
  transitioning: number;
  /** Instance representations across levels; cross-fades may draw a plant more than once. */
  drawnInstances: number;
  /** Representations at primary, LOD1, LOD2 and LOD3; levels overlap during fades. */
  levels: number[];
}
const emptyStats = (): FoliageViewStats => ({
  instances: 0,
  culled: 0,
  batches: 0,
  triangles: 0,
  levels: [0, 0, 0, 0],
  transitioning: 0,
  drawnInstances: 0,
});

/** Bound pending ranges even when frustum culling postpones GPU upload indefinitely. */
function queueUpload(
  attribute: THREE.BufferAttribute,
  start: number,
  count: number,
) {
  const ranges = attribute.updateRanges;
  if (
    ranges.length === 1 &&
    ranges[0].start === 0 &&
    ranges[0].count === attribute.array.length
  ) {
    attribute.needsUpdate = true;
    return;
  }
  if (ranges.length >= 64) {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, attribute.array.length);
  } else attribute.addUpdateRange(start, count);
  attribute.needsUpdate = true;
}

/** Shared foliage drawing, sparse contact response, and camera-dependent detail selection. */
export class TerrainFoliage extends THREE.Group {
  /** Called only after adopting a population, never for failed preparation. */
  onPopulationChanged?: () => void;
  private owned = new Set<{ dispose(): void }>();
  private edit?: EditTransaction;
  private retained?: TerrainFoliage;
  private tiles: Tile[] = [];
  private clusters?: FoliageDrawClusters;
  private fadingTiles = new Set<Tile>();
  private uniforms = windUniforms();
  private locations = new Map<number, { tile: Tile; index: number }>();
  private interaction = new FoliageInteraction();
  private modelInteractions = new Map<
    FoliageModel,
    TerrainProject['interaction']
  >();
  private maximumContactRadius = 0;
  private elapsed = 0;
  private windBoundStrength = 0;
  private viewDirty = true;
  private lastCamera = new THREE.Vector3(Infinity, Infinity, Infinity);
  private cameraPosition = new THREE.Vector3();
  private project: TerrainProject;
  viewStats = emptyStats();
  constructor(
    project: TerrainProject,
    private library: ModelLibrary,
    private options: FoliageRenderOptions = {},
  ) {
    super();
    this.project = project;
    this.name = 'Foliage';
  }
  /** Build detached draw buffers; failure leaves the current population and contacts intact. */
  prepare(project: TerrainProject, models?: PreparedModels): PreparedFoliage {
    const candidate = new TerrainFoliage(project, this.library, this.options);
    try {
      candidate.elapsed = this.elapsed;
      candidate.interaction = this.interaction.fork(project.foliage);
      for (const _step of candidate.build(project, models)) {
        void _step;
      }
      candidate.updateWind();
      return new PreparedResource(this, candidate, () => candidate.dispose());
    } catch (error) {
      candidate.dispose();
      throw error;
    }
  }
  /** Same detached transaction as prepare(), cooperatively yielding between spatial cells. */
  async prepareAsync(
    project: TerrainProject,
    models: PreparedModels | undefined,
    signal: AbortSignal,
    yieldWork: (signal: AbortSignal) => Promise<void>,
  ): Promise<PreparedFoliage> {
    checkSignal(signal);
    const candidate = new TerrainFoliage(project, this.library, this.options);
    try {
      candidate.elapsed = this.elapsed;
      candidate.interaction = this.interaction.fork(project.foliage);
      let deadline = performance.now() + 4;
      for (const _step of candidate.build(project, models)) {
        void _step;
        checkSignal(signal);
        if (performance.now() >= deadline) {
          await yieldWork(signal);
          deadline = performance.now() + 4;
        }
      }
      checkSignal(signal);
      candidate.updateWind();
      return new PreparedResource(this, candidate, () => candidate.dispose());
    } catch (error) {
      candidate.dispose();
      throw error;
    }
  }
  private state() {
    return {
      project: this.project,
      tiles: this.tiles,
      clusters: this.clusters,
      fadingTiles: this.fadingTiles,
      uniforms: this.uniforms,
      locations: this.locations,
      interaction: this.interaction,
      modelInteractions: this.modelInteractions,
      maximumContactRadius: this.maximumContactRadius,
      elapsed: this.elapsed,
      windBoundStrength: this.windBoundStrength,
      viewDirty: this.viewDirty,
      lastCamera: this.lastCamera,
      viewStats: this.viewStats,
      owned: this.owned,
      children: [...this.children],
    };
  }
  private restoreState(state: ReturnType<TerrainFoliage['state']>) {
    this.project = state.project;
    this.tiles = state.tiles;
    this.clusters = state.clusters;
    this.fadingTiles = state.fadingTiles;
    this.uniforms = state.uniforms;
    this.locations = state.locations;
    this.interaction = state.interaction;
    this.modelInteractions = state.modelInteractions;
    this.maximumContactRadius = state.maximumContactRadius;
    this.elapsed = state.elapsed;
    this.windBoundStrength = state.windBoundStrength;
    this.viewDirty = state.viewDirty;
    this.lastCamera = state.lastCamera;
    this.viewStats = state.viewStats;
    this.owned = state.owned;
    for (const child of state.children) this.add(child);
  }
  private exchange(other: TerrainFoliage) {
    const current = this.state(),
      next = other.state();
    this.clear();
    other.clear();
    this.restoreState(next);
    other.restoreState(current);
  }
  apply(prepared: PreparedFoliage) {
    const candidate = prepared.take(this);
    this.exchange(candidate);
    candidate.dispose();
    this.onPopulationChanged?.();
  }
  /** Preserve the exact previous population while a geometry-only edit is previewed. */
  beginEdit(project: TerrainProject): EditTransaction {
    if (this.edit) throw new Error('A foliage edit is already active.');
    const prepared = this.prepare(project),
      previous = prepared.take(this);
    this.exchange(previous);
    this.retained = previous;
    const finish = () => {
      this.edit = undefined;
      this.retained = undefined;
    };
    const edit = new EditTransaction(
      () => {
        finish();
        previous.dispose();
        this.onPopulationChanged?.();
      },
      () => {
        finish();
        this.exchange(previous);
        previous.dispose();
      },
    );
    this.edit = edit;
    return edit;
  }
  rebuild(project: TerrainProject) {
    const prepared = this.prepare(project);
    try {
      this.apply(prepared);
    } finally {
      prepared.dispose();
    }
  }
  private own<T extends { dispose(): void }>(resource: T): T {
    this.owned.add(resource);
    return resource;
  }
  private *build(project: TerrainProject, models?: PreparedModels) {
    this.windBoundStrength = Math.ceil(
      project.wind.enabled ? project.wind.strength : 0,
    );
    const holes = effectiveHoles(project),
      prepared = new Map<object, Map<string, THREE.BufferGeometry>>();
    // Spatial batches have independent transforms/contact/fade attributes, but
    // share material inputs. Fade coverage is data, so transitions never require
    // new material variants or shader compilation.
    const materialCache = new Map<
      FoliageModel,
      Map<number, Map<ModelPart, BatchMaterials>>
    >();
    const materialsFor = (
      model: FoliageModel,
      part: ModelPart,
      level: number,
      root: number | undefined,
      hasFade: boolean,
    ): BatchMaterials => {
      let levels = materialCache.get(model);
      if (!levels) materialCache.set(model, (levels = new Map()));
      let parts = levels.get(level);
      if (!parts) levels.set(level, (parts = new Map()));
      const cached = parts.get(part);
      if (cached) return cached;
      const sources = Array.isArray(part.material)
        ? part.material
        : [part.material];
      const colors = sources.map((source) => {
        const material = this.own(source.clone());
        if (material instanceof THREE.MeshStandardMaterial)
          material.color.lerp(new THREE.Color(model.color), 0.3);
        configureWind(material, model.wind, this.uniforms, root);
        configureFoliageSubsurface(material, model.subsurface);
        if (hasFade) configureFoliageFade(material);
        configureImpostorMaterial(material, part, model.subsurface);
        return material;
      });
      const shadows = shadowMaterials(
        sources[0],
        model.wind,
        this.uniforms,
        root,
        (resource) => this.own(resource),
      );
      if (hasFade) {
        configureFoliageFade(shadows.depth);
        configureFoliageFade(shadows.distance);
      }
      const result = {
        color: Array.isArray(part.material) ? colors : colors[0],
        ...shadows,
      };
      parts.set(part, result);
      return result;
    };
    for (const brush of project.brushes) {
      const groups = new Map<string, FoliageInstance[]>(),
        tileSize = 32;
      for (const instance of project.foliage) {
        if (
          instance.brushId !== brush.id ||
          isHole(project, instance.x, instance.z, holes)
        )
          continue;
        const model = foliageModel(brush, instance);
        if (!model) continue;
        const key =
          model.id +
          ':' +
          Math.floor(instance.x / tileSize) +
          ',' +
          Math.floor(instance.z / tileSize);
        const instances = groups.get(key) ?? [];
        instances.push(instance);
        groups.set(key, instances);
      }
      for (const [key, instances] of groups) {
        const model = foliageModel(brush, instances[0])!,
          count = instances.length,
          bounds = this.library.bounds(model.model, models),
          root = model.flexibility ? bounds.min.y : undefined,
          lazy =
            !!this.options.lazyInstances &&
            !!(model.lods?.length || model.cullDistance),
          geometryKey = JSON.stringify([
            model.flexibility,
            bounds.min.y,
            bounds.max.y,
          ]);
        const transitions =
          (model.lodFadeDuration ?? 0) > 0 &&
          (model.lods?.length || model.cullDistance)
            ? new FoliageLodTransitions(
                count,
                (model.lods?.length ?? 0) + 1,
                model.lodFadeDuration!,
              )
            : undefined;
        if (lazy && transitions)
          for (let i = 0; i < count; i++) transitions.setTarget(i, -1, 0, true);
        const tile: Tile = {
          instances,
          model,
          matrices: new Float32Array(count * 16),
          contacts: new Float32Array(count),
          root,
          ranks: Float64Array.from(instances, (instance) =>
            foliageDensityRank(instance.id),
          ),
          selected: new Int8Array(count).fill(-1),
          drawn:
            transitions?.targets ?? new Int8Array(count).fill(lazy ? -1 : 0),
          transitions,
          visibleCount: lazy ? 0 : count,
          batches: [],
          counts: [lazy ? 0 : count, 0, 0, 0],
          camera: new THREE.Vector3(),
          guard: 0,
        };
        const levels = [
          model.model,
          ...(model.lods ?? []).map((lod) => lod.model),
        ];
        levels.forEach((asset, level) => {
          // A level can only draw its deterministic density subset, including
          // during retargeted fades. Reserve exactly that subset, not every plant.
          const density = level === 0 ? 1 : model.lods![level - 1].density;
          let capacity = 0;
          for (const rank of tile.ranks) if (rank < density) capacity++;
          const impostor =
            level > 0 && level === levels.length - 1
              ? this.options.impostors?.get(model.model)
              : undefined;
          for (const part of impostor?.parts ??
            this.library.get(asset, models)) {
            const normal = materialsFor(
              model,
              part,
              level,
              root,
              !!transitions,
            );
            const variants =
              prepared.get(part) ?? new Map<string, THREE.BufferGeometry>();
            prepared.set(part, variants);
            let baseGeometry = variants.get(geometryKey);
            if (!baseGeometry) {
              const lease = this.library.geometry(part, geometryKey, () => {
                const geometry = part.geometry.clone();
                try {
                  geometry.applyMatrix4(part.matrix);
                  geometry.computeBoundingSphere();
                  geometry.computeBoundingBox();
                  if (model.flexibility)
                    prepareFlexibility(geometry, model.flexibility, bounds);
                  return geometry;
                } catch (error) {
                  geometry.dispose();
                  throw error;
                }
              });
              this.own({ dispose: () => lease.release() });
              baseGeometry = lease.value;
              variants.set(geometryKey, baseGeometry);
            }
            const contact = model.flexibility
              ? new THREE.InstancedBufferAttribute(
                  new Float32Array(lazy ? 0 : capacity),
                  1,
                ).setUsage(THREE.DynamicDrawUsage)
              : undefined;
            const fade = transitions
              ? new THREE.InstancedBufferAttribute(
                  new Float32Array(lazy ? 0 : capacity * 3),
                  3,
                ).setUsage(THREE.DynamicDrawUsage)
              : undefined;
            const attributes: Record<
              string,
              THREE.BufferAttribute | THREE.InterleavedBufferAttribute
            > = {};
            if (contact) attributes[CONTACT_SHADER_ATTRIBUTE] = contact;
            if (fade) attributes[FOLIAGE_FADE_ATTRIBUTE] = fade;
            const geometry = this.own(
              foliageGeometryView(baseGeometry, attributes),
            );
            const box = baseGeometry.boundingBox!,
              pivot = root ?? 0;
            const impostorSphere = baseGeometry.getAttribute(
              'terrainImpostorSphere',
            );
            const radius = impostorSphere
              ? Math.hypot(
                  impostorSphere.getX(0),
                  impostorSphere.getY(0) - pivot,
                  impostorSphere.getZ(0),
                ) +
                Math.SQRT2 * impostorSphere.getW(0)
              : Math.hypot(
                  Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
                  Math.max(
                    Math.abs(box.min.y - pivot),
                    Math.abs(box.max.y - pivot),
                  ),
                  Math.max(Math.abs(box.min.z), Math.abs(box.max.z)),
                );
            const mesh = this.own(
              new THREE.InstancedMesh(
                geometry,
                normal.color,
                lazy ? 0 : capacity,
              ),
            );
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            registerFoliageBatch(mesh, attributes, this.uniforms, capacity);
            mesh.customDepthMaterial = normal.depth;
            mesh.customDistanceMaterial = normal.distance;
            mesh.castShadow = mesh.receiveShadow = true;
            mesh.frustumCulled = true;
            mesh.count = level === 0 && !lazy ? count : 0;
            mesh.visible = mesh.count > 0;
            mesh.name = brush.name + ' ' + key + (level ? ' LOD' + level : '');
            mesh.userData = {
              brushId: brush.id,
              modelId: model.id,
              model: asset,
              lodLevel: level,
              lodDistance: level === 0 ? 0 : model.lods![level - 1].distance,
              instanceIds:
                level === 0 && !lazy
                  ? instances.map((instance) => instance.id)
                  : [],
            };
            const slots = new Int32Array(count).fill(-1);
            if (level === 0 && !lazy)
              for (let i = 0; i < count; i++) slots[i] = i;
            tile.batches.push({
              capacity,
              mesh,
              level,
              slots,
              baseGeometry,
              contact,
              fade,
              radius,
            });
            this.add(mesh);
          }
        });
        this.tiles.push(tile);
        instances.forEach((instance, index) =>
          this.locations.set(instance.id, { tile, index }),
        );
        yield;
      }
    }
    this.modelInteractions.clear();
    this.maximumContactRadius = 0;
    for (const tile of this.tiles) {
      const interaction = tile.model.interaction;
      if (!interaction) continue;
      this.modelInteractions.set(tile.model, { ...interaction, strength: 1 });
      if (interaction.enabled)
        this.maximumContactRadius = Math.max(
          this.maximumContactRadius,
          interaction.radius,
        );
    }
    this.interaction.setInstances(project.foliage);
    this.updateMatrices(0);
    for (const tile of this.tiles) {
      if (tile.transitions && !this.options.lazyInstances) this.pack(tile);
      this.fitBounds(tile);
    }
    this.clusters =
      this.options.distantClusters === false
        ? undefined
        : new FoliageDrawClusters(
            this.tiles.flatMap((tile) => tile.batches),
            this,
            this.uniforms,
            (resource) => this.own(resource),
            typeof this.options.distantClusters === 'object'
              ? this.options.distantClusters
              : undefined,
          );
    this.viewDirty = true;
    this.lastCamera.set(Infinity, Infinity, Infinity);
    this.refreshStats();
  }
  private updateMatrices(
    dt: number,
    contacts: GroundContact[] = [],
    region?: TerrainRegion,
  ) {
    const project = this.project;
    const changed = this.interaction.update(
      dt,
      contacts,
      project.interaction,
      (id) => {
        const model = this.locations.get(id)?.tile.model;
        return model ? this.modelInteractions.get(model) : undefined;
      },
      this.maximumContactRadius,
    );
    const touched = new Set<Tile>();
    if (dt > 0 && !changed.size) return touched;
    const dummy = new THREE.Object3D(),
      yaw = new THREE.Quaternion(),
      up = new THREE.Vector3(0, 1, 0),
      normal = new THREE.Vector3();
    const spacing = project.size / project.resolution;
    const targets = new Map<Tile, number[]>();
    if (dt > 0)
      for (const id of changed) {
        const location = this.locations.get(id);
        if (!location) continue;
        const indices = targets.get(location.tile) ?? [];
        indices.push(location.index);
        targets.set(location.tile, indices);
      }
    for (const tile of dt > 0 ? targets.keys() : this.tiles) {
      const indices = dt > 0 ? targets.get(tile)! : tile.instances.keys();
      for (const i of indices) {
        const instance = tile.instances[i],
          model = tile.model;
        if (
          region &&
          (instance.x < region.minX ||
            instance.x > region.maxX ||
            instance.z < region.minZ ||
            instance.z > region.maxZ)
        )
          continue;
        const crush = this.interaction.amount(instance.id) * model.crush;
        tile.contacts[i] = crush;
        const updateMatrix = !model.flexibility || dt === 0;
        if (updateMatrix) {
          dummy.position.set(
            instance.x,
            heightAt(project, instance.x, instance.z),
            instance.z,
          );
          dummy.quaternion.identity();
          if (model.alignToNormal) {
            normal
              .set(
                heightAt(project, instance.x - spacing, instance.z) -
                  heightAt(project, instance.x + spacing, instance.z),
                2 * spacing,
                heightAt(project, instance.x, instance.z - spacing) -
                  heightAt(project, instance.x, instance.z + spacing),
              )
              .normalize();
            dummy.quaternion.setFromUnitVectors(up, normal);
          }
          yaw.setFromAxisAngle(up, instance.rotation);
          dummy.quaternion.multiply(yaw);
          const wholePlantCrush = model.flexibility ? 0 : crush;
          dummy.rotateZ(wholePlantCrush * 0.9);
          dummy.scale.set(
            instance.scale,
            instance.scale * (1 - wholePlantCrush * 0.75),
            instance.scale,
          );
          dummy.updateMatrix();
          dummy.matrix.toArray(tile.matrices, i * 16);
        }
        for (const batch of tile.batches) {
          const slot = batch.slots[i];
          if (slot < 0) continue;
          if (updateMatrix) {
            batch.mesh.setMatrixAt(slot, dummy.matrix);
            queueUpload(batch.mesh.instanceMatrix, slot * 16, 16);
          }
          if (batch.contact) {
            batch.contact.setX(slot, crush);
            queueUpload(batch.contact, slot, 1);
          }
        }
        touched.add(tile);
      }
    }
    for (const tile of touched) this.clusters?.invalidate(tile.batches);
    return touched;
  }
  private fitBounds(tile: Tile) {
    const matrix = new THREE.Matrix4(),
      part = new THREE.Sphere();
    for (const batch of tile.batches) {
      const bound = new THREE.Sphere().makeEmpty();
      for (let i = 0; i < tile.instances.length; i++) {
        matrix.fromArray(tile.matrices, i * 16);
        part.center.set(0, tile.root ?? 0, 0).applyMatrix4(matrix);
        const extent = batch.radius * tile.instances[i].scale;
        // Contact rotation/compression cannot grow this pivot-centred sphere.
        // Wind is evaluated in terrain metres; bound every phase and gust.
        part.radius =
          (extent +
            this.windBoundStrength *
              tile.model.wind *
              0.09 *
              Math.pow(extent, 1.25)) *
            1.0001 +
          0.0001;
        bound.union(part);
      }
      batch.mesh.boundingSphere = bound;
    }
    this.clusters?.invalidate(tile.batches);
  }
  reanchor(region: TerrainRegion) {
    const pad = (2 * this.project.size) / this.project.resolution;
    for (const tile of this.updateMatrices(0, [], {
      minX: region.minX - pad,
      maxX: region.maxX + pad,
      minZ: region.minZ - pad,
      maxZ: region.maxZ + pad,
    }))
      this.fitBounds(tile);
    this.viewDirty = true;
    this.clusters?.update();
  }
  private updateWind() {
    const wind = this.project.wind,
      angle = (wind.direction * Math.PI) / 180;
    {
      const uniforms = this.uniforms;
      uniforms.uTime.value = this.elapsed;
      uniforms.uStrength.value = wind.enabled ? wind.strength : 0;
      uniforms.uDirection.value.set(Math.cos(angle), Math.sin(angle));
      uniforms.uGust.value = wind.gust;
      uniforms.uSpeed.value = wind.speed;
    }
    return wind;
  }
  update(dt: number, contacts: GroundContact[] = [], camera?: THREE.Camera) {
    this.elapsed += dt;
    const wind = this.updateWind();
    if (wind.enabled && wind.strength > this.windBoundStrength) {
      this.windBoundStrength = Math.ceil(wind.strength);
      for (const tile of this.tiles) this.fitBounds(tile);
    }
    this.updateMatrices(dt, contacts);
    if (camera) this.updateView(camera);
    this.advanceTransitions();
    this.clusters?.update();
    // Keep animation/contact time moving on the retained landscape too.
    if (this.retained) {
      this.updateWorldMatrix(true, false);
      this.retained.matrix.copy(this.matrixWorld);
      this.retained.matrixAutoUpdate = false;
      this.retained.update(dt, contacts, camera);
    }
  }
  /** Select detail in terrain-local space, including parent transforms. */
  updateView(camera: THREE.Camera) {
    camera.getWorldPosition(this.cameraPosition);
    this.worldToLocal(this.cameraPosition);
    if (!this.viewDirty && this.lastCamera.equals(this.cameraPosition))
      return this.viewStats;
    this.lastCamera.copy(this.cameraPosition);
    const force = this.viewDirty;
    this.viewDirty = false;
    let changed = false;
    for (const tile of this.tiles) {
      if (!tile.model.lods?.length && !tile.model.cullDistance) continue;
      if (
        !force &&
        tile.camera.distanceToSquared(this.cameraPosition) <
          tile.guard * tile.guard
      )
        continue;
      tile.camera.copy(this.cameraPosition);
      tile.guard = Infinity;
      let dirty = false;
      const lods = tile.model.lods ?? [];
      for (let i = 0; i < tile.instances.length; i++) {
        const instance = tile.instances[i];
        const dx = this.cameraPosition.x - instance.x,
          dy = this.cameraPosition.y - tile.matrices[i * 16 + 13],
          dz = this.cameraPosition.z - instance.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const previous = tile.selected[i];
        const level = foliageDistanceLevel(tile.model, distance, previous);
        tile.selected[i] = level;
        const hysteresis = tile.model.lodHysteresis ?? 0.1;
        const lower =
          level === 0
            ? -Infinity
            : (level <= lods.length
                ? lods[level - 1].distance
                : tile.model.cullDistance || Infinity) *
              (1 - hysteresis);
        const upper =
          level > lods.length
            ? Infinity
            : (level < lods.length
                ? lods[level].distance
                : tile.model.cullDistance || Infinity) *
              (1 + hysteresis);
        tile.guard = Math.min(
          tile.guard,
          Math.max(0, distance - lower),
          Math.max(0, upper - distance),
        );
        const density = level === 0 ? 1 : (lods[level - 1]?.density ?? 0);
        const drawn =
          level <= lods.length && tile.ranks[i] < density ? level : -1;
        if (drawn !== tile.drawn[i]) {
          if (tile.transitions) {
            tile.transitions.setTarget(i, drawn, this.elapsed, previous < 0);
            if (tile.transitions.activeCount) this.fadingTiles.add(tile);
            else this.fadingTiles.delete(tile);
          } else tile.drawn[i] = drawn;
          dirty = true;
        }
      }
      if (dirty) {
        this.pack(tile);
        changed = true;
      }
    }
    if (changed) this.refreshStats();
    return this.viewStats;
  }
  private advanceTransitions() {
    let changed = false;
    for (const tile of this.fadingTiles) {
      const transitions = tile.transitions!;
      let completed = false;
      transitions.advance(this.elapsed, (index, finished) => {
        if (finished) {
          completed = true;
          return;
        }
        for (const batch of tile.batches) {
          const slot = batch.slots[index];
          if (slot < 0) continue;
          transitions.writeRange(
            index,
            batch.level,
            batch.fade!.array,
            slot * 3,
          );
          queueUpload(batch.fade!, slot * 3, 2);
        }
      });
      this.clusters?.invalidate(tile.batches);
      if (completed) {
        this.pack(tile);
        changed = true;
      }
      if (!transitions.activeCount) this.fadingTiles.delete(tile);
    }
    if (changed) this.refreshStats();
  }
  private pack(tile: Tile) {
    const groups: number[][] = Array.from(
      { length: (tile.model.lods?.length ?? 0) + 1 },
      () => [],
    );
    tile.visibleCount = 0;
    for (let i = 0; i < tile.drawn.length; i++) {
      let included = false;
      for (let level = 0; level < groups.length; level++)
        if (
          tile.transitions
            ? tile.transitions.includes(i, level)
            : tile.drawn[i] === level
        ) {
          groups[level].push(i);
          included = true;
        }
      if (included) tile.visibleCount++;
    }
    tile.counts = [0, 1, 2, 3].map((level) => groups[level]?.length ?? 0);
    for (const batch of tile.batches) {
      const sources = groups[batch.level],
        mesh = batch.mesh;
      if (sources.length && !mesh.instanceMatrix.count && batch.capacity) {
        // A distant cell needs no primary/intermediate draw storage until that
        // representation actually appears. Reserve its full deterministic subset once.
        mesh.instanceMatrix = new THREE.InstancedBufferAttribute(
          new Float32Array(batch.capacity * 16),
          16,
        ).setUsage(THREE.DynamicDrawUsage);
        const attributes: Record<string, THREE.BufferAttribute> = {};
        if (batch.contact) {
          batch.contact = new THREE.InstancedBufferAttribute(
            new Float32Array(batch.capacity),
            1,
          ).setUsage(THREE.DynamicDrawUsage);
          mesh.geometry.setAttribute(CONTACT_SHADER_ATTRIBUTE, batch.contact);
          attributes[CONTACT_SHADER_ATTRIBUTE] = batch.contact;
        }
        if (batch.fade) {
          batch.fade = new THREE.InstancedBufferAttribute(
            new Float32Array(batch.capacity * 3),
            3,
          ).setUsage(THREE.DynamicDrawUsage);
          mesh.geometry.setAttribute(FOLIAGE_FADE_ATTRIBUTE, batch.fade);
          attributes[FOLIAGE_FADE_ATTRIBUTE] = batch.fade;
        }
        registerFoliageBatch(mesh, attributes, this.uniforms, batch.capacity);
      }
      const repack =
        mesh.count !== sources.length ||
        sources.some((source, slot) => batch.slots[source] !== slot);
      if (repack) batch.slots.fill(-1);
      const matrices = mesh.instanceMatrix.array;
      sources.forEach((source, slot) => {
        if (repack) {
          batch.slots[source] = slot;
          batch.contact?.setX(slot, tile.contacts[source]);
          matrices.set(
            tile.matrices.subarray(source * 16, source * 16 + 16),
            slot * 16,
          );
        }
        if (batch.fade) {
          tile.transitions!.writeRange(
            source,
            batch.level,
            batch.fade.array,
            slot * 3,
          );
          batch.fade.setZ(slot, tile.ranks[source]);
        }
      });
      mesh.count = sources.length;
      mesh.visible = !mesh.userData.clusteredSource && mesh.count > 0;
      if (repack) {
        mesh.userData.instanceIds = sources.map((i) => tile.instances[i].id);
        mesh.instanceMatrix.clearUpdateRanges();
        if (mesh.count) mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (batch.fade) {
        batch.fade.clearUpdateRanges();
        if (mesh.count) batch.fade.addUpdateRange(0, mesh.count * 3);
        batch.fade.needsUpdate = true;
      }
      if (batch.contact && repack) {
        batch.contact.clearUpdateRanges();
        if (mesh.count) batch.contact.addUpdateRange(0, mesh.count);
        batch.contact.needsUpdate = true;
      }
    }
    this.clusters?.invalidate(tile.batches);
  }
  /** Full primary meshes, for authoring comparison; never changes project instances. */
  resetView() {
    this.fadingTiles.clear();
    for (const tile of this.tiles) {
      tile.selected.fill(-1);
      tile.transitions?.reset();
      tile.drawn.fill(0);
      this.pack(tile);
    }
    this.viewDirty = true;
    this.refreshStats();
  }
  private refreshStats() {
    this.clusters?.update();
    const stats = emptyStats();
    for (const tile of this.tiles) {
      let selected = 0;
      tile.counts.forEach((count, level) => {
        stats.levels[level] += count;
        selected += count;
      });
      stats.drawnInstances += selected;
      stats.instances += tile.visibleCount;
      stats.culled += tile.instances.length - tile.visibleCount;
      stats.transitioning += tile.transitions?.activeCount ?? 0;
    }
    for (const mesh of this.children as THREE.InstancedMesh[])
      if (mesh.visible && mesh.count) {
        stats.batches++;
        stats.triangles +=
          (mesh.count *
            (mesh.geometry.index?.count ??
              mesh.geometry.getAttribute('position').count)) /
          3;
      }
    this.viewStats = stats;
  }
  clearInteractions() {
    this.interaction.clear();
    this.updateMatrices(0);
    this.clusters?.update();
  }
  /** Independent geometry/draw buffers, all primary instances. Caller disposes meshes, geometries, and materials; textures remain shared. Masked foliage exports its rest pose. */
  forExport() {
    const group = new THREE.Group();
    group.name = this.name;
    const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
    const materials = new Map<THREE.Material, THREE.Material>();
    const staticMaterial = (source: THREE.Material) => {
      let material = materials.get(source);
      if (!material) {
        material = source.clone();
        materials.set(source, material);
      }
      return material;
    };
    for (const tile of this.tiles)
      for (const batch of tile.batches)
        if (batch.level === 0) {
          const original = batch.mesh;
          let geometry = geometries.get(batch.baseGeometry);
          if (!geometry) {
            geometry = batch.baseGeometry.clone();
            geometry.deleteAttribute(FLEXIBILITY_SHADER_ATTRIBUTE);
            geometries.set(batch.baseGeometry, geometry);
          }
          const mesh = new THREE.InstancedMesh(
            geometry,
            Array.isArray(original.material)
              ? original.material.map(staticMaterial)
              : staticMaterial(original.material),
            tile.instances.length,
          );
          mesh.name = original.name;
          mesh.instanceMatrix.array.set(tile.matrices);
          mesh.userData = {
            ...original.userData,
            instanceIds: tile.instances.map((instance) => instance.id),
          };
          delete mesh.userData.clusteredSource;
          group.add(mesh);
        }
    return group;
  }
  private releaseMeshes() {
    // Track resources as soon as they are created, including incomplete batches.
    for (const resource of this.owned) resource.dispose();
    this.owned.clear();
    this.clear();
    this.tiles = [];
    this.clusters = undefined;
    this.fadingTiles.clear();
    this.locations.clear();
    this.modelInteractions.clear();
  }
  dispose() {
    this.edit?.rollback();
    this.releaseMeshes();
    this.interaction.clear();
  }
}
