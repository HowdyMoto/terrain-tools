import {
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
} from 'three';
import type {
  BufferAttribute,
  InstancedMesh,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { WindUniforms } from '../runtime/wind';
import {
  FoliageMotionHistory,
  foliageMotionFrame,
  beginAutomaticFoliageFrame,
} from './foliage-motion';

export const foliageMatrixAttribute = 'terrainInstance';
export const foliagePreviousAttribute = 'terrainPreviousInstance';
export const foliagePreviousStateAttribute = 'terrainPreviousState';
export const foliageCurrentStateAttribute = 'terrainInstanceState';
type Attributes = Record<string, BufferAttribute | InterleavedBufferAttribute>;
interface Batch {
  owned: Attributes;
  current?: InstancedInterleavedBuffer;
  previous?: InstancedInterleavedBuffer;
  states?: InterleavedBufferAttribute;
  wind: WindUniforms;
  history?: FoliageMotionHistory;
  historyVersion?: number;
  matrixVersion?: number;
  contactVersion?: number;
  fadeVersion?: number;
}
const batches = new WeakMap<InstancedMesh, Batch>();
const installed = new WeakSet<WebGPURenderer>();

/** Keep authored meshes/picking/GLB export as InstancedMesh. Native rendering uses
 * geometry-owned instance attributes, so equal batches can share a node program
 * without capturing another batch's matrix buffer in that program's bindings. */
export function registerFoliageBatch(
  mesh: InstancedMesh,
  owned: Attributes,
  wind: WindUniforms,
) {
  batches.set(mesh, { owned, wind });
}

/** Conservative one-view streaming reservation, including CPU pose snapshots.
 * Geometry accounting can also include the packed GPU buffer; double counting
 * it is intentional during admission. Extra independent views need host budgets. */
export function foliageMotionReservation(mesh: InstancedMesh) {
  if (!batches.has(mesh)) return { cpuBytes: 0, gpuBytes: 0 };
  return {
    cpuBytes: mesh.instanceMatrix.count * 352 + 1024,
    gpuBytes: mesh.instanceMatrix.count * 88,
  };
}

/** Three r186 specializes InstancedMesh node programs per object. A plain Mesh
 * over InstancedBufferGeometry has the same draw, but resolves attributes from
 * each draw's geometry and can safely reuse the material's compiled node state.
 * The proxy never enters the scene: source visibility, bounds and picking apply.
 */
export function installNativeFoliage(renderer: WebGPURenderer) {
  if (installed.has(renderer)) return;
  installed.add(renderer);
  const render = renderer.render;
  renderer.render = function (scene, camera) {
    const endFrame = beginAutomaticFoliageFrame(renderer, camera);
    try {
      return render.call(this, scene, camera);
    } finally {
      endFrame();
    }
  };
  const proxies = new WeakMap<InstancedMesh, Mesh>();
  const histories = new WeakMap<
    InstancedMesh,
    WeakMap<object, FoliageMotionHistory>
  >();
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
      // Versioned updates are deliberate. Three's DynamicDrawUsage forces
      // another full-capacity upload in unchanged shadow/water/main passes.
      batch.current = new InstancedInterleavedBuffer(
        new Float32Array(source.instanceMatrix.count * 20),
        20,
        1,
      );
      batch.previous = new InstancedInterleavedBuffer(
        new Float32Array(source.instanceMatrix.count * 18),
        18,
        1,
      );
      batch.states = new InterleavedBufferAttribute(batch.previous, 2, 16);
      batch.owned[foliagePreviousStateAttribute] = batch.states;
      geometry.setAttribute(foliagePreviousStateAttribute, batch.states);
      const state = new InterleavedBufferAttribute(batch.current, 4, 16);
      batch.owned[foliageCurrentStateAttribute] = state;
      geometry.setAttribute(foliageCurrentStateAttribute, state);
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
    const contact = geometry.getAttribute('terrainContact') as
      InstancedBufferAttribute | undefined;
    const fade = geometry.getAttribute('terrainFade') as
      InstancedBufferAttribute | undefined;
    if (
      batch.matrixVersion !== source.instanceMatrix.version ||
      batch.contactVersion !== (contact?.version ?? 0) ||
      batch.fadeVersion !== (fade?.version ?? 0)
    ) {
      for (let slot = 0; slot < source.count; slot++) {
        batch.current.array.set(
          source.instanceMatrix.array.subarray(slot * 16, slot * 16 + 16),
          slot * 20,
        );
        batch.current.array[slot * 20 + 16] = contact?.getX(slot) ?? 0;
        batch.current.array[slot * 20 + 17] = fade?.getX(slot) ?? 0;
        batch.current.array[slot * 20 + 18] = fade?.getY(slot) ?? 1;
        batch.current.array[slot * 20 + 19] = fade?.getZ(slot) ?? 0;
      }
      batch.current.clearUpdateRanges();
      batch.current.addUpdateRange(0, source.count * 20);
      batch.current.needsUpdate = true;
      batch.matrixVersion = source.instanceMatrix.version;
      batch.contactVersion = contact?.version ?? 0;
      batch.fadeVersion = fade?.version ?? 0;
    }
    let proxy = proxies.get(source);
    if (!proxy) {
      const mesh = new Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorld = source.matrixWorld;
      // The original owns geometry/materials. Release only the renderer's proxy
      // records when its batch is retired, including during cancelled edits.
      source.addEventListener('dispose', () => {
        mesh.dispatchEvent({ type: 'dispose' } as never);
        proxies.delete(source);
      });
      proxies.set(source, (proxy = mesh));
    }
    if (renderer.getMRT()?.has('velocity')) {
      let cameras = histories.get(source);
      if (!cameras) histories.set(source, (cameras = new WeakMap()));
      let history = cameras.get(camera);
      if (!history) {
        history = new FoliageMotionHistory(source.instanceMatrix.count);
        cameras.set(camera, history);
      }
      const wind = batch.wind;
      history.prepare(
        foliageMotionFrame(renderer),
        source.userData.instanceIds,
        source.instanceMatrix.array as Float32Array,
        source.instanceMatrix.version,
        contact?.array as Float32Array | undefined,
        contact?.version ?? 0,
        [
          wind.uTime.value,
          wind.uStrength.value,
          wind.uSpeed.value,
          wind.uGust.value,
          wind.uDirection.value.x,
          wind.uDirection.value.y,
        ],
      );
      proxy.userData.terrainPreviousWind = history.wind;
      proxy.userData.terrainPreviousDirection = history.direction;
      if (
        batch.history !== history ||
        batch.historyVersion !== history.version
      ) {
        for (let slot = 0; slot < source.count; slot++) {
          batch.previous!.array.set(
            history.matrices.subarray(slot * 16, slot * 16 + 16),
            slot * 18,
          );
          batch.previous!.array[slot * 18 + 16] = history.states[slot * 2];
          batch.previous!.array[slot * 18 + 17] = history.states[slot * 2 + 1];
        }
        batch.previous!.clearUpdateRanges();
        batch.previous!.addUpdateRange(0, source.count * 18);
        batch.previous!.needsUpdate = true;
        batch.history = history;
        batch.historyVersion = history.version;
      }
    }
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
