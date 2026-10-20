import { Matrix4 } from 'three';
import type {
  Camera,
  Material,
  Node,
  NodeBuilder,
  WebGPURenderer,
} from 'three/webgpu';
import { Fn, output, uniform } from 'three/tsl';
import { foliageMotionFrame } from './foliage-motion';

export type HistoryMaterial = Material & { terrainHistoryNode?: Node<'float'> };

/** Coverage alpha must remain available to MSAA. Store history confidence in the
 * unused velocity alpha channel instead of interpreting leaf opacity as motion. */
export const temporalHistoryConfidence = Fn((builder: NodeBuilder) => {
  return (builder.material as HistoryMaterial).terrainHistoryNode ?? output.a;
})();

interface ViewHistory {
  serial: number;
  epoch: object;
  matrix: Matrix4;
  scaleX: number;
  scaleY: number;
  confidence: number;
}
const views = new WeakMap<WebGPURenderer, WeakMap<Camera, ViewHistory>>();

/** Card view changes lack exact reprojection. Reject their history while the
 * camera changes, then accumulate normally when it rests. Projection jitter is
 * deliberately excluded; it is sampling, not a change in the viewer's pose. */
export const impostorViewConfidence = uniform(1).onRenderUpdate((frame) => {
  const renderer = frame.renderer as WebGPURenderer,
    camera = frame.camera!;
  const { serial, epoch } = foliageMotionFrame(renderer);
  let cameras = views.get(renderer);
  if (!cameras) views.set(renderer, (cameras = new WeakMap()));
  let previous = cameras.get(camera);
  if (previous?.serial === serial && previous.epoch === epoch)
    return previous.confidence;
  const projection = camera.projectionMatrix.elements;
  const continuous =
    previous?.epoch === epoch && previous.serial + 1 === serial;
  const stable =
    previous !== undefined &&
    continuous &&
    previous.matrix.equals(camera.matrixWorld) &&
    previous.scaleX === projection[0] &&
    previous.scaleY === projection[5];
  if (!previous) {
    previous = {
      serial,
      epoch,
      matrix: new Matrix4(),
      scaleX: projection[0],
      scaleY: projection[5],
      confidence: 0.1,
    };
    cameras.set(camera, previous);
  }
  previous.serial = serial;
  previous.epoch = epoch;
  previous.matrix.copy(camera.matrixWorld);
  previous.scaleX = projection[0];
  previous.scaleY = projection[5];
  previous.confidence = stable ? 1 : 0.1;
  return previous.confidence;
});
