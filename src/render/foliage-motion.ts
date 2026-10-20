import { Vector2, Vector4 } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

export interface FoliageMotionFrame {
  serial: number;
  epoch: object;
}
const frames = new WeakMap<WebGPURenderer, FoliageMotionFrame>();
const automatic = new WeakMap<WebGPURenderer, WeakMap<object, number>>();
/** Direct runtime renders also have a logical frame, independent of RAF rate. */
export function beginAutomaticFoliageFrame(
  renderer: WebGPURenderer,
  camera: object,
) {
  if (frames.has(renderer)) return () => {};
  let cameras = automatic.get(renderer);
  if (!cameras) automatic.set(renderer, (cameras = new WeakMap()));
  const serial = (cameras.get(camera) ?? 0) + 1;
  cameras.set(camera, serial);
  return beginFoliageMotionFrame(renderer, { serial, epoch: camera });
}
/** All opaque/water/shadow draws in one composition retain the same history. */
export function beginFoliageMotionFrame(
  renderer: WebGPURenderer,
  frame: FoliageMotionFrame,
) {
  const previous = frames.get(renderer);
  frames.set(renderer, frame);
  return () => {
    if (previous) frames.set(renderer, previous);
    else frames.delete(renderer);
  };
}
export function foliageMotionFrame(
  renderer: WebGPURenderer,
): FoliageMotionFrame {
  return (
    frames.get(renderer) ?? { serial: renderer.info.frame, epoch: renderer }
  );
}

/** Last drawn instance data, matched by authored ID rather than compacted slot.
 * Matrices/contact snapshots only copy when their source versions change.
 * Histories belong to one renderer/camera; buffers returned here are CPU owned. */
export class FoliageMotionHistory {
  readonly matrices: Float32Array;
  /** Previous contact amount and valid-history flag, two floats per instance. */
  readonly states: Float32Array;
  readonly wind = new Vector4();
  readonly direction = new Vector2();
  version = 0;
  private snapshot: Float32Array;
  private contacts: Float32Array;
  private ids: readonly number[] = [];
  private indices = new Map<number, number>();
  private windSnapshot = new Float64Array(6);
  private frame?: FoliageMotionFrame;
  private matrixVersion = -1;
  private contactVersion = -1;
  private settled = false;
  constructor(capacity: number) {
    this.matrices = new Float32Array(capacity * 16);
    this.states = new Float32Array(capacity * 2);
    this.snapshot = new Float32Array(capacity * 16);
    this.contacts = new Float32Array(capacity);
  }
  prepare(
    frame: FoliageMotionFrame,
    ids: readonly number[],
    matrices: Float32Array,
    matrixVersion: number,
    contacts: Float32Array | undefined,
    contactVersion: number,
    wind: readonly number[],
  ) {
    if (this.frame?.serial === frame.serial && this.frame.epoch === frame.epoch)
      return;
    const continuous =
      this.frame?.epoch === frame.epoch &&
      this.frame.serial + 1 === frame.serial;
    const previousWind = continuous ? this.windSnapshot : wind;
    this.wind.set(
      previousWind[0],
      previousWind[1],
      previousWind[2],
      previousWind[3],
    );
    this.direction.set(previousWind[4], previousWind[5]);
    const changed =
      ids !== this.ids ||
      this.matrixVersion !== matrixVersion ||
      this.contactVersion !== contactVersion;
    if (changed || !continuous || !this.settled) {
      for (let slot = 0; slot < ids.length; slot++) {
        const old = continuous ? this.indices.get(ids[slot]) : undefined;
        const offset = slot * 16;
        const source = old === undefined ? matrices : this.snapshot;
        const sourceOffset = (old ?? slot) * 16;
        this.matrices.set(
          source.subarray(sourceOffset, sourceOffset + 16),
          offset,
        );
        this.states[slot * 2] =
          old === undefined ? (contacts?.[slot] ?? 0) : this.contacts[old];
        this.states[slot * 2 + 1] = old === undefined ? 0 : 1;
      }
      this.version++;
    }
    // One additional frame settles a changed pose into its new previous state.
    this.settled = continuous && !changed;
    if (changed) {
      this.snapshot.set(matrices.subarray(0, ids.length * 16));
      if (contacts) this.contacts.set(contacts.subarray(0, ids.length));
      else this.contacts.fill(0, 0, ids.length);
      if (ids !== this.ids) {
        this.indices.clear();
        ids.forEach((id, slot) => this.indices.set(id, slot));
        // Authoring replaces the packed ID list on every repack.
        this.ids = ids;
      }
      this.matrixVersion = matrixVersion;
      this.contactVersion = contactVersion;
    }
    this.windSnapshot.set(wind);
    this.frame = { ...frame };
  }
}
