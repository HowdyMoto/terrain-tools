import { Matrix4, VelocityNode } from 'three/webgpu';
import type { NodeFrame, WebGPURenderer } from 'three/webgpu';
import {
  modelViewMatrix,
  positionLocal,
  positionPrevious,
  uniform,
} from 'three/tsl';
import { foliageMotionFrame } from './foliage-motion';

interface Pose {
  serial: number;
  epoch: object;
  current: Matrix4;
  previous: Matrix4;
  projection: Matrix4;
  previousProjection: Matrix4;
}
/** Native velocity uses a stable projection binding even when a material was
 * compiled before TRAA, or TRAA replaces its jitter controller on resize.
 * History advances once per composed view, independent of auxiliary passes. */
export class TerrainVelocityNode extends VelocityNode {
  private cameras = new WeakMap<object, Pose>();
  private objects = new WeakMap<object, WeakMap<object, Pose>>();
  private currentProjection = uniform(new Matrix4()).onObjectUpdate(
    ({ camera }): Matrix4 => {
      return this.currentProjection.value.copy(
        this.projectionMatrix ?? camera!.projectionMatrix,
      );
    },
  );
  private pose(
    map: WeakMap<object, Pose>,
    key: object,
    matrix: Matrix4,
    projection: Matrix4,
    serial: number,
    epoch: object,
  ) {
    let pose = map.get(key);
    if (!pose) {
      pose = {
        serial,
        epoch,
        current: matrix.clone(),
        previous: matrix.clone(),
        projection: projection.clone(),
        previousProjection: projection.clone(),
      };
      map.set(key, pose);
    } else if (pose.serial !== serial || pose.epoch !== epoch) {
      const continuous = pose.epoch === epoch && pose.serial + 1 === serial;
      pose.previous.copy(continuous ? pose.current : matrix);
      pose.previousProjection.copy(continuous ? pose.projection : projection);
      pose.current.copy(matrix);
      pose.projection.copy(projection);
      pose.serial = serial;
      pose.epoch = epoch;
    }
    return pose;
  }
  override update(frame: NodeFrame): undefined {
    if (!frame.camera || !frame.object) return;
    const { serial, epoch } = foliageMotionFrame(
      frame.renderer as WebGPURenderer,
    );
    const projection = this.projectionMatrix ?? frame.camera.projectionMatrix;
    const camera = this.pose(
      this.cameras,
      frame.camera,
      frame.camera.matrixWorldInverse,
      projection,
      serial,
      epoch,
    );
    let objects = this.objects.get(frame.camera);
    if (!objects) this.objects.set(frame.camera, (objects = new WeakMap()));
    const object = this.pose(
      objects,
      frame.object,
      frame.object.matrixWorld,
      projection,
      serial,
      epoch,
    );
    this.previousModelWorldMatrix.value.copy(object.previous);
    this.previousCameraViewMatrix.value.copy(camera.previous);
    this.previousProjectionMatrix.value.copy(camera.previousProjection);
  }
  override updateAfter(): undefined {
    /* Commit is frame-scoped in update, never per pass. */
  }
  override setup() {
    const current = this.currentProjection
      .mul(modelViewMatrix)
      .mul(positionLocal);
    const previous = this.previousProjectionMatrix
      .mul(this.previousCameraViewMatrix)
      .mul(this.previousModelWorldMatrix)
      .mul(positionPrevious);
    return current.xy.div(current.w).sub(previous.xy.div(previous.w));
  }
}
