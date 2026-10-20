import { describe, expect, it } from 'vitest';
import { Camera, Matrix4, Object3D, PerspectiveCamera } from 'three';
import { NodeFrame } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { TerrainVelocityNode } from '../src/render/native-velocity';
import { beginFoliageMotionFrame } from '../src/render/foliage-motion';

describe('native composed velocity history', () => {
  it('retains the previous camera and object through auxiliary passes and resets projection history', () => {
    const node = new TerrainVelocityNode();
    const renderer = {} as WebGPURenderer;
    const camera = new PerspectiveCamera(),
      object = new Object3D(),
      epoch = {};
    const update = (serial: number, token = epoch, view: Camera = camera) => {
      const end = beginFoliageMotionFrame(renderer, { serial, epoch: token });
      try {
        node.update(
          Object.assign(new NodeFrame(), { renderer, camera: view, object }),
        );
        node.updateAfter();
      } finally {
        end();
      }
    };
    update(1);
    camera.position.x = 2;
    camera.updateMatrixWorld();
    object.position.x = 3;
    object.updateMatrixWorld();
    update(2);
    expect(node.previousModelWorldMatrix.value.elements[12]).toBe(0);
    expect(node.previousCameraViewMatrix.value.elements[12]).toBe(0);
    update(2);
    expect(node.previousModelWorldMatrix.value.elements[12]).toBe(0);
    update(3);
    expect(node.previousModelWorldMatrix.value.elements[12]).toBe(3);
    expect(node.previousCameraViewMatrix.value.elements[12]).toBe(-2);
    camera.aspect = 2;
    camera.updateProjectionMatrix();
    const reset = {};
    update(4, reset);
    expect(
      node.previousProjectionMatrix.value.equals(camera.projectionMatrix),
    ).toBe(true);
    const other = new PerspectiveCamera();
    update(1, other, other);
    object.position.x = 5;
    object.updateMatrixWorld();
    update(5, reset);
    expect(node.previousModelWorldMatrix.value.elements[12]).toBe(3);
    expect(
      node.previousCameraViewMatrix.value.equals(
        new Matrix4().makeTranslation(-2, 0, 0),
      ),
    ).toBe(true);
  });
});
