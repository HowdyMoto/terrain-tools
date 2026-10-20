import * as THREE from 'three';
import {
  foliageGeometryView,
  CONTACT_SHADER_ATTRIBUTE,
} from '../render/foliage-flexibility';
import { registerFoliageBatch } from '../render/native-foliage';
import { FOLIAGE_FADE_ATTRIBUTE } from './foliage-fade';
import type { WindUniforms } from './wind';

export interface FoliageClusterSource {
  /** Logical ceiling when source draw storage is allocated lazily. */
  capacity?: number;
  mesh: THREE.InstancedMesh;
  baseGeometry: THREE.BufferGeometry;
  contact?: THREE.InstancedBufferAttribute;
  fade?: THREE.InstancedBufferAttribute;
}
export interface FoliageClusterOptions {
  /** Also group primary/intermediate draws in 64 m cells. Extra source buffers
   * remain resident and larger cells reduce culling precision. Default: false. */
  nearby?: boolean;
}
interface Cluster {
  sources: FoliageClusterSource[];
  mesh: THREE.InstancedMesh;
  contact?: THREE.InstancedBufferAttribute;
  fade?: THREE.InstancedBufferAttribute;
  versions: number[];
  bounds: (THREE.Sphere | null)[];
}
/** Combine compatible distant opaque draws into 128 m cells, optionally using
 * 64 m cells for primary/intermediate levels too.
 * Geometry, IDs, wind, fade coverage and shadow materials remain unchanged.
 * Sources remain available for authoring; this is batching, not an impostor bake. */
export class FoliageDrawClusters {
  private bySource = new WeakMap<THREE.InstancedMesh, Cluster>();
  private dirty = new Set<Cluster>();
  constructor(
    sources: FoliageClusterSource[],
    parent: THREE.Group,
    wind: WindUniforms,
    own: <T extends { dispose(): void }>(resource: T) => T,
    options: FoliageClusterOptions = {},
  ) {
    const materials = new Map<
      THREE.Material | THREE.Material[],
      Map<THREE.BufferGeometry, Map<string, FoliageClusterSource[]>>
    >();
    for (const source of sources) {
      const mesh = source.mesh;
      if (!(source.capacity ?? mesh.instanceMatrix.count)) continue;
      if (
        !options.nearby &&
        (mesh.userData.lodLevel < 2 || mesh.userData.lodDistance < 96)
      )
        continue;
      const surfaces = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      // Preserve separate object sorting for blended and refractive materials.
      if (
        surfaces.some(
          (surface) =>
            surface.transparent ||
            (surface instanceof THREE.MeshPhysicalMaterial &&
              surface.transmission > 0),
        )
      )
        continue;
      let geometries = materials.get(mesh.material);
      if (!geometries) materials.set(mesh.material, (geometries = new Map()));
      let cells = geometries.get(source.baseGeometry);
      if (!cells) geometries.set(source.baseGeometry, (cells = new Map()));
      const center = mesh.boundingSphere!.center;
      const cellSize =
        mesh.userData.lodLevel >= 2 && mesh.userData.lodDistance >= 96
          ? 128
          : 64;
      const key =
        cellSize +
        ':' +
        Math.floor(center.x / cellSize) +
        ',' +
        Math.floor(center.z / cellSize);
      const group = cells.get(key) ?? [];
      group.push(source);
      cells.set(key, group);
    }
    for (const geometries of materials.values())
      for (const cells of geometries.values())
        for (const group of cells.values()) {
          if (group.length < 2) continue;
          const first = group[0],
            capacity = group.reduce(
              (sum, source) =>
                sum + (source.capacity ?? source.mesh.instanceMatrix.count),
              0,
            );
          const contact = first.contact
            ? new THREE.InstancedBufferAttribute(
                new Float32Array(capacity),
                1,
              ).setUsage(THREE.DynamicDrawUsage)
            : undefined;
          const fade = first.fade
            ? new THREE.InstancedBufferAttribute(
                new Float32Array(capacity * 3),
                3,
              ).setUsage(THREE.DynamicDrawUsage)
            : undefined;
          const attributes: Record<
            string,
            THREE.BufferAttribute | THREE.InterleavedBufferAttribute
          > = {};
          if (contact) attributes[CONTACT_SHADER_ATTRIBUTE] = contact;
          if (fade) attributes[FOLIAGE_FADE_ATTRIBUTE] = fade;
          const geometry = own(
            foliageGeometryView(first.baseGeometry, attributes),
          );
          const mesh = own(
            new THREE.InstancedMesh(geometry, first.mesh.material, capacity),
          );
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.customDepthMaterial = first.mesh.customDepthMaterial;
          mesh.customDistanceMaterial = first.mesh.customDistanceMaterial;
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.name = first.mesh.name + ' draw cluster';
          mesh.userData = {
            ...first.mesh.userData,
            clustered: true,
            sourceBatches: group.length,
            instanceIds: [],
          };
          registerFoliageBatch(mesh, attributes, wind);
          parent.add(mesh);
          for (const source of group)
            source.mesh.userData.clusteredSource = true;
          const cluster: Cluster = {
            sources: group,
            mesh,
            contact,
            fade,
            versions: [],
            bounds: [],
          };
          this.dirty.add(cluster);
          for (const source of group) this.bySource.set(source.mesh, cluster);
        }
    this.update();
  }
  /** Source changes are owned by TerrainFoliage. Wind-only frames need no scan
   * of inactive authoring buffers, nor any packed-instance upload. */
  invalidate(sources: FoliageClusterSource[]) {
    for (const source of sources) {
      const cluster = this.bySource.get(source.mesh);
      if (cluster) this.dirty.add(cluster);
    }
  }
  update() {
    for (const cluster of this.dirty) {
      let matricesChanged = false,
        contactsChanged = false,
        fadesChanged = false,
        boundsChanged = false;
      cluster.sources.forEach((source, index) => {
        const mesh = source.mesh,
          offset = index * 4;
        mesh.visible = false;
        const countChanged = cluster.versions[offset] !== mesh.count;
        matricesChanged ||=
          countChanged ||
          cluster.versions[offset + 1] !== mesh.instanceMatrix.version;
        contactsChanged ||=
          countChanged ||
          cluster.versions[offset + 2] !== (source.contact?.version ?? -1);
        fadesChanged ||=
          countChanged ||
          cluster.versions[offset + 3] !== (source.fade?.version ?? -1);
        boundsChanged ||= cluster.bounds[index] !== mesh.boundingSphere;
        cluster.versions[offset] = mesh.count;
        cluster.versions[offset + 1] = mesh.instanceMatrix.version;
        cluster.versions[offset + 2] = source.contact?.version ?? -1;
        cluster.versions[offset + 3] = source.fade?.version ?? -1;
        cluster.bounds[index] = mesh.boundingSphere;
      });
      if (boundsChanged) {
        const bounds = new THREE.Sphere().makeEmpty();
        for (const source of cluster.sources)
          bounds.union(source.mesh.boundingSphere!);
        cluster.mesh.boundingSphere = bounds;
      }
      if (!matricesChanged && !contactsChanged && !fadesChanged) continue;
      const ids: number[] = [];
      let count = 0;
      for (const source of cluster.sources) {
        const size = source.mesh.count;
        if (matricesChanged)
          cluster.mesh.instanceMatrix.array.set(
            source.mesh.instanceMatrix.array.subarray(0, size * 16),
            count * 16,
          );
        if (contactsChanged && cluster.contact)
          cluster.contact.array.set(
            source.contact!.array.subarray(0, size),
            count,
          );
        if (fadesChanged && cluster.fade)
          cluster.fade.array.set(
            source.fade!.array.subarray(0, size * 3),
            count * 3,
          );
        for (const id of source.mesh.userData.instanceIds as number[])
          ids.push(id);
        count += size;
      }
      cluster.mesh.count = count;
      cluster.mesh.visible = count > 0;
      const previous = cluster.mesh.userData.instanceIds as number[];
      if (
        previous.length !== ids.length ||
        ids.some((id, index) => id !== previous[index])
      )
        cluster.mesh.userData.instanceIds = ids;
      for (const [attribute, changed, stride] of [
        [cluster.mesh.instanceMatrix, matricesChanged, 16],
        [cluster.contact, contactsChanged, 1],
        [cluster.fade, fadesChanged, 3],
      ] as const) {
        if (!attribute || !changed) continue;
        attribute.clearUpdateRanges();
        if (count) attribute.addUpdateRange(0, count * stride);
        attribute.needsUpdate = true;
      }
    }
    this.dirty.clear();
  }
}
