import {
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  DynamicDrawUsage,
  Mesh,
} from 'three';
import type {
  BufferAttribute,
  InstancedMesh,
  InstancedBufferGeometry,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';

export const foliageMatrixAttribute = 'terrainInstance';
export const foliagePreviousAttribute = 'terrainPreviousInstance';
type Attributes = Record<string, BufferAttribute | InterleavedBufferAttribute>;
interface Batch {
  owned: Attributes;
  current?: InstancedInterleavedBuffer;
  previous?: InstancedInterleavedBuffer;
  previousVersion: number;
}
const batches = new WeakMap<InstancedMesh, Batch>();
const installed = new WeakSet<WebGPURenderer>();

/** Keep authored meshes/picking/GLB export as InstancedMesh. Native rendering uses
 * geometry-owned instance attributes, so equal batches can share a node program
 * without capturing another batch's matrix buffer in that program's bindings. */
export function registerFoliageBatch(mesh: InstancedMesh, owned: Attributes) {
  batches.set(mesh, { owned, previousVersion: mesh.instanceMatrix.version });
}

/** Three r186 specializes InstancedMesh node programs per object. A plain Mesh
 * over InstancedBufferGeometry has the same draw, but resolves attributes from
 * each draw's geometry and can safely reuse the material's compiled node state.
 * The proxy never enters the scene: source visibility, bounds and picking apply.
 */
export function installNativeFoliage(renderer: WebGPURenderer) {
  if (installed.has(renderer)) return;
  installed.add(renderer);
  const proxies = new WeakMap<InstancedMesh, Mesh>();
  const renderObject = renderer.renderObject;
  renderer.renderObject = function (
    object,
    scene,
    camera,
    geometry,
    material,
    ...rest
  ) {
    const source = object as InstancedMesh;
    const batch = batches.get(source);
    if (!batch)
      return renderObject.call(
        this,
        object,
        scene,
        camera,
        geometry,
        material,
        ...rest,
      );
    // Attributes belong to the batch, not a renderer. A second viewport must
    // not replace buffers still in use by the first viewport's cached bindings.
    if (!batch.current) {
      batch.current = new InstancedInterleavedBuffer(
        source.instanceMatrix.array,
        16,
        1,
      ).setUsage(DynamicDrawUsage);
      batch.previous = new InstancedInterleavedBuffer(
        source.instanceMatrix.array.slice(),
        16,
        1,
      ).setUsage(DynamicDrawUsage);
      for (const [prefix, buffer] of [
        [foliageMatrixAttribute, batch.current],
        [foliagePreviousAttribute, batch.previous],
      ] as const) {
        for (let i = 0; i < 4; i++) {
          const name = prefix + i;
          batch.owned[name] = new InterleavedBufferAttribute(buffer, 4, i * 4);
          geometry.setAttribute(name, batch.owned[name]);
        }
      }
    }
    let proxy = proxies.get(source);
    if (!proxy) {
      const mesh = new Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorld = source.matrixWorld;
      mesh.onAfterRender = (_r, _s, _c, _g, drawnMaterial) => {
        if (
          (drawnMaterial as { isShadowPassMaterial?: boolean })
            .isShadowPassMaterial
        )
          return;
        if (batch.previousVersion !== source.instanceMatrix.version) {
          batch.previous!.array.set(source.instanceMatrix.array);
          batch.previous!.needsUpdate = true;
          batch.previousVersion = source.instanceMatrix.version;
        }
      };
      // The original owns geometry/materials. Release only the renderer's proxy
      // records when its batch is retired, including during cancelled edits.
      source.addEventListener('dispose', () => {
        mesh.dispatchEvent({ type: 'dispose' } as never);
        proxies.delete(source);
      });
      proxies.set(source, (proxy = mesh));
    }
    batch.current.version = source.instanceMatrix.version;
    proxy.material = material;
    proxy.receiveShadow = source.receiveShadow;
    proxy.castShadow = source.castShadow;
    (geometry as InstancedBufferGeometry).instanceCount = source.count;
    return renderObject.call(
      this,
      proxy,
      scene,
      camera,
      geometry,
      material,
      ...rest,
    );
  };
}
