import { describe, expect, it } from 'vitest';
import { Euler, PerspectiveCamera, Vector3 } from 'three';
import { createProject, heightAt } from '../src/core/terrain';
import { TerrainWalker } from '../src/render/first-person';
import { WalkPlacement } from '../src/render/walk-placement';
import { DEFAULT_EYE_HEIGHT } from '../src/core/project-settings';

function ground() {
  const project = createProject(32, 64);
  project.heights.fill(0);
  project.view.water = false;
  return project;
}

describe('walk start placement', () => {
  it('uses the chosen point and heading, with a level eye-height view and no document changes', () => {
    const project = ground();
    const before = structuredClone(project);
    const placement = new WalkPlacement(project);
    const result = placement.inspect(new Vector3(8, 999, 4), 1.2);
    const camera = new PerspectiveCamera();
    camera.rotation.set(-1, 0.4, 0.2);
    new TerrainWalker(project, result.start).enter(camera);
    expect(camera.position.toArray()).toEqual([8, DEFAULT_EYE_HEIGHT, 4]);
    const look = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    expect(look.x).toBeCloseTo(0);
    expect(look.y).toBeCloseTo(1.2);
    expect(look.z).toBeCloseTo(0);
    expect(project).toEqual(before);
    placement.dispose();
  });

  it('starts on steep slopes at the exact chosen location, including when facing uphill', () => {
    const project = ground();
    for (let z = 0; z <= project.resolution; z++)
      for (let x = 0; x <= project.resolution; x++)
        project.heights[z * (project.resolution + 1) + x] = x * 6;
    const point = new Vector3(0.3, 0, 4.7);
    const placement = new WalkPlacement(project);
    for (const yaw of [-Math.PI / 2, Math.PI / 2]) {
      const result = placement.preview(point, yaw)!;
      const camera = new PerspectiveCamera();
      new TerrainWalker(project, result.start).enter(camera);
      expect(camera.position.toArray()).toEqual([
        point.x,
        heightAt(project, point.x, point.z) + DEFAULT_EYE_HEIGHT,
        point.z,
      ]);
      expect(placement.marker.position.toArray()).toEqual([
        point.x,
        heightAt(project, point.x, point.z),
        point.z,
      ]);
    }
    placement.dispose();
  });

  it('does not veto terrain near scenery, water, holes or edges', () => {
    const project = ground();
    project.view.water = true;
    project.view.waterLevel = 3;
    project.holes[16 * project.resolution + 16] = 1;
    project.props = [
      {
        id: 1,
        model: 'boulder',
        x: 0,
        z: 0,
        yOffset: 0,
        scale: 10,
        rotation: 0,
        cutHole: false,
        holeRadius: 1,
      },
    ];
    project.foliage = [
      {
        id: 2,
        brushId: project.brushes[0].id,
        x: 0,
        z: 0,
        scale: 10,
        rotation: 0,
      },
    ];
    const placement = new WalkPlacement(project);
    for (const point of [new Vector3(-0.1, 0, 0.5), new Vector3(31.9, 0, 0)]) {
      const result = placement.preview(point, 0)!;
      const camera = new PerspectiveCamera();
      new TerrainWalker(project, result.start).enter(camera);
      expect(camera.position.toArray()).toEqual([
        point.x,
        DEFAULT_EYE_HEIGHT,
        point.z,
      ]);
    }
    placement.dispose();
  });

  it('hides the preview when not pointing at terrain and disposes its resources', () => {
    const placement = new WalkPlacement(ground());
    expect(placement.preview(new Vector3(), 0)).not.toBeNull();
    expect(placement.marker.visible).toBe(true);
    expect(placement.preview(null, 0)).toBeNull();
    expect(placement.marker.visible).toBe(false);
    let disposed = 0;
    placement.marker.traverse((object) => {
      if ('geometry' in object)
        (object.geometry as import('three').BufferGeometry).addEventListener(
          'dispose',
          () => disposed++,
        );
    });
    placement.dispose();
    expect(disposed).toBe(4);
  });
});
