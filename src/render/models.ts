import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decodeModel, ModelResources } from './model-loader';
import type { DecodedModel, ModelDecoder } from './model-loader';
import {
  PreparedResource,
  SharedResource,
  checkSignal,
  linkedController,
  cancelled,
} from './resources';
import type { TerrainProject } from '../core/types';
export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  matrix: THREE.Matrix4;
}
type ModelAsset = SharedResource<{ data: string; decoded: DecodedModel }>;
export type PreparedModels = PreparedResource<Map<string, ModelAsset>>;
export class ModelLibrary {
  private models = new Map<string, ModelPart[]>();
  private imported = new Map<string, ModelAsset>();
  private requests = new Set<AbortController>();
  private loading?: AbortController;
  private disposed = false;
  constructor(private decode: ModelDecoder = decodeModel) {
    const standard = (color: string) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    const part = (
      geometry: THREE.BufferGeometry,
      color: string,
    ): ModelPart => ({
      geometry,
      material: standard(color),
      matrix: new THREE.Matrix4(),
    });
    const trunk = new THREE.CylinderGeometry(0.12, 0.25, 3.5, 7).translate(
      0,
      1.75,
      0,
    );
    const leaves = mergeGeometries([
      new THREE.ConeGeometry(1.6, 3, 9).translate(0, 3.2, 0),
      new THREE.ConeGeometry(1.3, 2.8, 9).translate(0, 4.5, 0),
      new THREE.ConeGeometry(0.95, 2.5, 9).translate(0, 5.7, 0),
    ])!;
    this.models.set('pine', [part(trunk, '#5e4c38'), part(leaves, '#607961')]);
    this.models.set('pine-low', [
      part(
        new THREE.CylinderGeometry(0.12, 0.25, 3.5, 4).translate(0, 1.75, 0),
        '#5e4c38',
      ),
      part(
        new THREE.ConeGeometry(1.6, 5.25, 6).translate(0, 4.325, 0),
        '#607961',
      ),
    ]);
    const blades: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const height = 0.9 + (i % 3) * 0.18;
      const blade = new THREE.BufferGeometry();
      blade.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          [
            -0.1,
            0,
            0,
            0.1,
            0,
            0,
            -0.055,
            height * 0.55,
            0.05,
            0.055,
            height * 0.55,
            0.05,
            0,
            height,
            0.18,
          ],
          3,
        ),
      );
      blade.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
      blade.computeVertexNormals();
      blade.rotateY(i * 2.4);
      blade.translate(Math.sin(i * 2.4) * 0.2, 0, Math.cos(i * 2.4) * 0.2);
      blades.push(blade);
    }
    const grass = part(mergeGeometries(blades)!, '#a5b373');
    (grass.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    this.models.set('grass', [grass]);
    const grassLow = part(blades[0].clone(), '#a5b373');
    (grassLow.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    this.models.set('grass-low', [grassLow]);
    blades.forEach((blade) => blade.dispose());
    const rock = new THREE.IcosahedronGeometry(1.8, 1)
      .scale(1.3, 0.7, 1)
      .translate(0, 0.8, 0);
    this.models.set('boulder', [part(rock, '#8d8c82')]);
    const slab = new THREE.BoxGeometry(7, 0.6, 5).translate(0, 0.5, 0);
    this.models.set('platform', [part(slab, '#aaa99b')]);
    const portal = mergeGeometries([
      new THREE.BoxGeometry(1, 6, 3).translate(-3, 3, 0),
      new THREE.BoxGeometry(1, 6, 3).translate(3, 3, 0),
      new THREE.BoxGeometry(7, 1, 3).translate(0, 6, 0),
    ])!;
    this.models.set('portal', [part(portal, '#989b93')]);
  }
  get(id: string, prepared?: PreparedModels) {
    if (this.disposed) throw new Error('Model library has been disposed.');
    if (prepared) this.assertPrepared(prepared);
    return (
      (prepared?.value ?? this.imported).get(id)?.value.decoded.parts ??
      this.models.get(id) ??
      this.models.get('boulder')!
    );
  }
  async prepareAssets(
    project: Pick<TerrainProject, 'assets'>,
    signal?: AbortSignal,
  ): Promise<PreparedModels> {
    if (this.disposed) throw new Error('Model library has been disposed.');
    const { controller, unlink } = linkedController(signal);
    this.requests.add(controller);
    const requested = Object.entries(project.assets).map(
      ([id, asset]) => [id, asset.data] as const,
    );
    const byData = new Map<string, ModelAsset>(),
      result = new Map<string, ModelAsset>(),
      leases = new Set<ModelAsset>();
    const release = () => {
      leases.forEach((asset) => asset.release());
      leases.clear();
    };
    controller.signal.addEventListener('abort', release, { once: true });
    try {
      checkSignal(controller.signal);
      // Retain every reused resource before the first await: another commit can replace this library meanwhile.
      const existing = new Map(
        [...this.imported.values()].map((asset) => [asset.value.data, asset]),
      );
      for (const [id, data] of requested) {
        if (this.models.has(id))
          throw new Error('Asset identifier conflicts with a built-in model.');
        const asset = existing.get(data);
        if (asset && !leases.has(asset)) {
          asset.retain();
          leases.add(asset);
          byData.set(data, asset);
        }
      }
      for (const [id, data] of requested) {
        checkSignal(controller.signal);
        let asset = byData.get(data);
        if (!asset) {
          const decoded = await this.decode(data, controller.signal);
          if (controller.signal.aborted || this.disposed) {
            decoded.dispose();
            throw cancelled();
          }
          asset = new SharedResource({ data, decoded }, () =>
            decoded.dispose(),
          );
          leases.add(asset);
          byData.set(data, asset);
        }
        result.set(id, asset);
      }
      return new PreparedResource(this, result, release);
    } catch (error) {
      release();
      throw error;
    } finally {
      controller.signal.removeEventListener('abort', release);
      this.requests.delete(controller);
      unlink();
    }
  }
  assertPrepared(prepared: PreparedModels) {
    if (this.disposed) throw new Error('Model library has been disposed.');
    prepared.assert(this);
  }
  apply(prepared: PreparedModels) {
    this.assertPrepared(prepared);
    this.loading?.abort();
    const previous = this.imported;
    this.imported = prepared.take(this);
    new Set(previous.values()).forEach((asset) => asset.release());
  }
  /** Standalone atomic replacement. Scene loading stages models and materials together. */
  async loadAssets(
    project: Pick<TerrainProject, 'assets'>,
    signal?: AbortSignal,
  ) {
    this.loading?.abort();
    const { controller, unlink } = linkedController(signal);
    this.loading = controller;
    let prepared: PreparedModels | undefined;
    try {
      prepared = await this.prepareAssets(project, controller.signal);
      checkSignal(controller.signal);
      if (this.loading !== controller) throw cancelled();
      this.loading = undefined;
      this.apply(prepared);
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
  /** Bounds in model-local space, including node transforms, before prop placement. */
  bounds(id: string, prepared?: PreparedModels) {
    const result = new THREE.Box3();
    for (const part of this.get(id, prepared)) {
      if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
      if (part.geometry.boundingBox)
        result.union(
          part.geometry.boundingBox.clone().applyMatrix4(part.matrix),
        );
    }
    return result;
  }
  object(id: string, prepared?: PreparedModels) {
    const group = new THREE.Group();
    for (const p of this.get(id, prepared)) {
      const mesh = new THREE.Mesh(p.geometry, p.material);
      mesh.applyMatrix4(p.matrix);
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loading?.abort();
    this.requests.forEach((controller) => controller.abort());
    new Set(this.imported.values()).forEach((asset) => asset.release());
    this.imported.clear();
    const resources = new ModelResources();
    for (const parts of this.models.values())
      for (const part of parts) {
        resources.collect(part.geometry);
        resources.collect(part.material);
      }
    resources.dispose();
    this.models.clear();
  }
}
