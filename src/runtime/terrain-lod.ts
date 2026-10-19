import * as THREE from 'three';
import { buildTerrainLods } from '../core/terrain-lod';
import type { TerrainScene } from './terrain-scene';

export interface TerrainLodOptions {
  /** Maximum sampled projected height error, in drawing-buffer pixels. */
  pixelError?: number;
  transitionSeconds?: number;
}
interface Chunk {
  mesh: THREE.Mesh;
  geometries: THREE.BufferGeometry[];
  errors: number[];
  current: number;
  morph: number;
  center: THREE.Vector3;
  radius: number;
}
/** Runtime-only adaptive drawing over an immutable authored terrain.
 * Collision/height queries retain the original full-resolution project.
 * Dispose/recreate after editing or replacing the source terrain.
 */
export class TerrainLod extends THREE.Group {
  private chunks: Chunk[] = [];
  private previousVisible: boolean;
  private cameraPosition = new THREE.Vector3();
  private allocated = new Set<THREE.BufferGeometry>();
  readonly options: Required<TerrainLodOptions>;
  constructor(
    private source: TerrainScene,
    options: TerrainLodOptions = {},
  ) {
    super();
    this.options = {
      pixelError: options.pixelError ?? 2,
      transitionSeconds: options.transitionSeconds ?? 0.2,
    };
    if (
      !Number.isFinite(this.options.pixelError) ||
      this.options.pixelError <= 0 ||
      !Number.isFinite(this.options.transitionSeconds) ||
      this.options.transitionSeconds < 0
    )
      throw new Error('Invalid terrain LOD settings.');
    this.previousVisible = source.terrain.visible;
    try {
      for (const original of source.terrain.children as THREE.Mesh[]) {
        const { cellsX, cellsZ } = original.userData;
        const levels = buildTerrainLods(
          original.geometry.getAttribute('position').array as Float32Array,
          original.geometry.index!.array as Uint32Array,
          cellsX,
          cellsZ,
        );
        const geometries = levels.map((level) => {
          const geometry = new THREE.BufferGeometry();
          this.allocated.add(geometry);
          for (const [name, attribute] of Object.entries(
            original.geometry.attributes,
          ))
            geometry.setAttribute(name, attribute);
          geometry.setIndex(new THREE.BufferAttribute(level.indices, 1));
          geometry.morphAttributes.position = [
            new THREE.BufferAttribute(level.target, 3),
          ];
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();
          return geometry;
        });
        const mesh = new THREE.Mesh(geometries[0], original.material);
        mesh.castShadow = mesh.receiveShadow = true;
        const bounds = geometries[0].boundingSphere!;
        this.chunks.push({
          mesh,
          geometries,
          errors: levels.map((l) => l.error),
          current: 0,
          morph: 0,
          center: bounds.center.clone(),
          radius: bounds.radius,
        });
        this.add(mesh);
      }
      source.terrain.visible = false;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  update(camera: THREE.Camera, heightPixels: number, dt: number) {
    if (
      !Number.isFinite(heightPixels) ||
      heightPixels <= 0 ||
      !Number.isFinite(dt) ||
      dt < 0
    )
      throw new Error('Invalid terrain LOD view.');
    this.updateWorldMatrix(true, false);
    this.worldToLocal(camera.getWorldPosition(this.cameraPosition));
    const perspective = camera as THREE.PerspectiveCamera;
    const factor = perspective.isPerspectiveCamera
      ? heightPixels /
        (2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2))
      : heightPixels /
        Math.max(
          1,
          (camera as THREE.OrthographicCamera).top -
            (camera as THREE.OrthographicCamera).bottom,
        );
    for (const chunk of this.chunks) {
      const distance = perspective.isPerspectiveCamera
        ? Math.max(
            1,
            this.cameraPosition.distanceTo(chunk.center) - chunk.radius,
          )
        : 1;
      let desired = 0;
      // Hysteresis prevents oscillating at a threshold. Refine earlier than coarsen.
      for (let i = 1; i < chunk.errors.length; i++)
        if (
          (chunk.errors[i] * factor) / distance <=
          this.options.pixelError * (i > chunk.current ? 0.8 : 1.2)
        )
          desired = i;
        else break;
      const step = this.options.transitionSeconds
        ? Math.min(dt, 0.1) / this.options.transitionSeconds
        : 1;
      if (desired < chunk.current && chunk.morph === 0) {
        chunk.current--;
        chunk.morph = 1;
        chunk.mesh.geometry = chunk.geometries[chunk.current];
        chunk.mesh.updateMorphTargets();
      }
      const direction = desired > chunk.current ? 1 : -1;
      chunk.morph = THREE.MathUtils.clamp(chunk.morph + direction * step, 0, 1);
      if (chunk.morph === 1 && desired > chunk.current) {
        chunk.current++;
        chunk.morph = 0;
        chunk.mesh.geometry = chunk.geometries[chunk.current];
        chunk.mesh.updateMorphTargets();
      }
      chunk.mesh.morphTargetInfluences![0] = chunk.morph;
    }
  }
  get stats() {
    return {
      chunks: this.chunks.length,
      triangles: this.chunks.reduce(
        (sum, c) => sum + c.mesh.geometry.index!.count / 3,
        0,
      ),
      fullTriangles: this.chunks.reduce(
        (sum, c) => sum + c.geometries[0].index!.count / 3,
        0,
      ),
      transitioning: this.chunks.filter((c) => c.morph > 0).length,
    };
  }
  get memoryBytes() {
    let cpuBytes = 0,
      gpuBytes = 0;
    for (const chunk of this.chunks)
      for (const geometry of chunk.geometries) {
        const index = geometry.index!.array.byteLength;
        const target = geometry.morphAttributes.position![0].array.byteLength;
        cpuBytes += index + target;
        // Conservative allowance for Three's packed RGBA morph texture.
        gpuBytes += index + target * 2;
      }
    return { cpuBytes, gpuBytes };
  }
  dispose() {
    for (const geometry of this.allocated) geometry.dispose();
    this.allocated.clear();
    this.chunks = [];
    this.clear();
    this.source.terrain.visible = this.previousVisible;
  }
}
