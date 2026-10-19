import { describe, expect, it } from 'vitest';
import { Euler, PerspectiveCamera, Vector3 } from 'three';
import { createProject, heightAt, isHole } from '../src/core/terrain';
import { TerrainWalker } from '../src/render/first-person';

function setup() {
  const project = createProject(32, 64);
  project.heights.fill(0);
  const camera = new PerspectiveCamera();
  const walker = new TerrainWalker(project, {
    position: new Vector3(0, 1.8, 0),
    yaw: 0,
  });
  walker.enter(camera);
  return { project, camera, walker };
}

describe('terrain walkthrough', () => {
  it('applies the complete mouse delta immediately with no delayed rotation or drift', () => {
    const { camera, walker } = setup();
    for (let i = 0; i < 20; i++) walker.mouseLook(camera, 3, -2);
    const expected = new Euler(0.08, -0.12, 0, 'YXZ');
    const actual = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    expect(actual.x).toBeCloseTo(expected.x);
    expect(actual.y).toBeCloseTo(expected.y);
    const stopped = camera.quaternion.clone();
    for (let i = 0; i < 60; i++) walker.update(camera, 1 / 60);
    expect(camera.quaternion.equals(stopped)).toBe(true);
    walker.mouseLook(camera, -60, 40);
    expect(
      camera.quaternion.angleTo(new PerspectiveCamera().quaternion),
    ).toBeCloseTo(0);
  });

  it('walks and strafes at constant speed, normalizes diagonals, and runs', () => {
    for (const [keys, speed] of [
      [['KeyW'], 6],
      [['KeyW', 'KeyD'], 6],
      [['KeyA'], 6],
      [['KeyS'], 6],
      [['KeyW', 'ShiftLeft'], 12],
    ] as const) {
      const { camera, walker } = setup();
      keys.forEach((key) => walker.setKey(key, true));
      for (let i = 0; i < 60; i++) walker.update(camera, 1 / 60);
      expect(Math.hypot(camera.position.x, camera.position.z)).toBeCloseTo(
        speed,
      );
      expect(camera.position.y).toBe(1.8);
    }
  });

  it('moves relative to yaw, keeps walking horizontal when looking up, and clamps pitch', () => {
    const { camera, walker } = setup();
    walker.mouseLook(camera, -Math.PI / 2 / 0.002, -100000);
    const angles = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    expect(angles.x).toBeCloseTo(Math.PI / 2 - 0.01);
    walker.setKey('KeyW', true);
    walker.update(camera, 0.1);
    expect(camera.position.x).toBeCloseTo(-0.6);
    expect(camera.position.z).toBeCloseTo(0);
    expect(camera.position.y).toBe(1.8);
    walker.mouseLook(camera, 0, 200000);
    expect(
      new Euler().setFromQuaternion(camera.quaternion, 'YXZ').x,
    ).toBeCloseTo(-Math.PI / 2 + 0.01);
  });

  it('follows the rendered triangle height while ascending and descending', () => {
    const { project, camera, walker } = setup();
    for (let z = 0; z <= project.resolution; z++) {
      for (let x = 0; x <= project.resolution; x++) {
        project.heights[z * (project.resolution + 1) + x] = z + x * 0.5;
      }
    }
    for (const key of ['KeyS', 'KeyW']) {
      walker.clearKeys();
      walker.setKey(key, true);
      for (let i = 0; i < 20; i++) {
        walker.update(camera, 0.05);
        expect(camera.position.y).toBeCloseTo(
          heightAt(project, camera.position.x, camera.position.z) + 1.8,
        );
      }
    }
  });

  it('blocks edges and painted/prop holes, including holes narrower than a frame step', () => {
    const project = createProject(512, 8);
    project.heights.fill(0);
    // A whole row of tiny holes lies across the travel direction.
    project.holes.fill(1, 255 * 512, 256 * 512);
    const camera = new PerspectiveCamera();
    const walker = new TerrainWalker(project, {
      position: new Vector3(0, 1.8, 0.1),
      yaw: 0,
    });
    walker.enter(camera);
    walker.setKey('KeyW', true);
    walker.setKey('ShiftLeft', true);
    for (let i = 0; i < 20; i++) walker.update(camera, 0.1);
    expect(camera.position.z).toBeGreaterThanOrEqual(0);
    walker.clearKeys();
    walker.setKey('KeyD', true);
    for (let i = 0; i < 20; i++) walker.update(camera, 0.1);
    expect(camera.position.x).toBeLessThan(4);
    expect(camera.position.x).toBeGreaterThan(3.9);
    expect(isHole(project, camera.position.x, camera.position.z)).toBe(false);
  });

  it('stops on release/reset and limits movement after a stalled frame', () => {
    const { camera, walker } = setup();
    walker.setKey('KeyW', true);
    walker.update(camera, 30);
    expect(camera.position.z).toBeCloseTo(-0.6);
    walker.setKey('KeyW', false);
    walker.update(camera, 0.1);
    expect(camera.position.z).toBeCloseTo(-0.6);
    walker.setKey('KeyD', true);
    walker.clearKeys();
    walker.update(camera, 0.1);
    expect(camera.position.x).toBe(0);
    walker.setKey('KeyW', true);
    walker.setKey('KeyS', true);
    walker.update(camera, 0.1);
    walker.update(camera, NaN);
    walker.update(camera, -1);
    expect(camera.position.z).toBeCloseTo(-0.6);
  });
});
