import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createProject, heightAt } from '../src/core/terrain';
import {
  DEFAULT_EYE_HEIGHT,
  parseEyeHeight,
  resizeTerrain,
} from '../src/core/project-settings';
import {
  parseProject,
  serializeProject,
  validateProjectData,
} from '../src/core/serialization';
import {
  parseProjectPackage,
  serializeProjectPackage,
} from '../src/core/project-package';
import { History } from '../src/core/history';
import { WalkPlacement } from '../src/render/walk-placement';
import { TerrainWalker } from '../src/render/first-person';

describe('project scale and first-person settings', () => {
  it('defaults new and legacy projects to a 1.8 m eye height and validates imported values', () => {
    const project = createProject(16, 64);
    expect(project.view.eyeHeight).toBe(1.8);
    delete project.view.eyeHeight;
    const legacy = parseProject(serializeProject(project));
    expect(parseEyeHeight(legacy.view.eyeHeight)).toBe(DEFAULT_EYE_HEIGHT);
    const placement = new WalkPlacement(legacy);
    expect(placement.eyeHeight).toBe(1.8);
    placement.dispose();
    for (const value of [0, -1, 100.1, NaN, Infinity, '1.8', null]) {
      expect(() =>
        validateProjectData({
          ...project,
          view: { ...project.view, eyeHeight: value },
        }),
      ).toThrow('eye height');
    }
    expect(parseEyeHeight(0.1)).toBe(0.1);
    expect(parseEyeHeight(100)).toBe(100);
  });

  it('uses the saved eye height for the preview, entry and terrain-following movement', () => {
    const project = createProject(16, 64);
    project.view.eyeHeight = 2.4;
    const placement = new WalkPlacement(project);
    const result = placement.preview(new Vector3(2, 0, 3), 0)!;
    const camera = new PerspectiveCamera();
    const walker = new TerrainWalker(project, result.start);
    walker.enter(camera);
    expect(placement.marker.position.y).toBeCloseTo(heightAt(project, 2, 3));
    expect(placement.marker.children[2].position.y).toBe(2.4);
    expect(camera.position.y).toBeCloseTo(heightAt(project, 2, 3) + 2.4);
    walker.setKey('KeyW', true);
    walker.update(camera, 0.1);
    expect(camera.position.y).toBeCloseTo(
      heightAt(project, camera.position.x, camera.position.z) + 2.4,
    );
    placement.dispose();
  });

  it('resizes landforms and anchored positions without changing resolution, painting, holes or model dimensions', () => {
    const project = createProject(32, 64);
    project.view.eyeHeight = 2.4;
    project.holes[3] = 1;
    project.paint[0] = 0.5;
    project.foliage = [
      { id: 1, brushId: 'pine', x: -8, z: 4, scale: 1.2, rotation: 0.5 },
    ];
    project.props = [
      {
        id: 2,
        model: 'platform',
        x: 10,
        z: -6,
        yOffset: 2,
        scale: 3,
        rotation: 1,
        cutHole: true,
        holeRadius: 2,
      },
    ];
    project.nextId = 3;
    const before = structuredClone(project);
    const next = resizeTerrain(project, 128);
    expect(next.resolution).toBe(32);
    expect(next.size).toBe(128);
    expect(heightAt(next, 6, 10)).toBeCloseTo(heightAt(project, 3, 5) * 2);
    expect(next.foliage[0]).toEqual({ ...project.foliage[0], x: -16, z: 8 });
    expect(next.props[0]).toEqual({ ...project.props[0], x: 20, z: -12 });
    expect(next.holes).toEqual(project.holes);
    expect(next.paint).toEqual(project.paint);
    expect(next.view).toEqual({ ...project.view, waterLevel: 2 });
    expect(next.materials).toEqual(project.materials);
    expect(project).toEqual(before);
    expect(parseProject(serializeProject(next))).toEqual(next);
  });

  it('can change only width and depth and rejects invalid sizes without altering the document', () => {
    const project = createProject(16, 64);
    project.heights.fill(16);
    const before = structuredClone(project);
    const next = resizeTerrain(project, 128, false);
    expect(next.heights).toEqual(project.heights);
    expect(next.view.waterLevel).toBe(project.view.waterLevel);
    for (const size of [0, 7.9, 10001, Infinity, NaN])
      expect(() => resizeTerrain(project, size)).toThrow('Terrain size');
    expect(() => resizeTerrain(project, 8, false)).toThrow(
      'Enable elevation scaling',
    );
    expect(project).toEqual(before);
  });

  it('round-trips project settings through native packages and undo/redo', async () => {
    const project = createProject(16, 64);
    const history = new History();
    history.checkpoint(project);
    const next = resizeTerrain(project, 128);
    next.view.eyeHeight = 2.1;
    const loaded = parseProjectPackage(
      await serializeProjectPackage(next).arrayBuffer(),
    );
    expect(loaded).toEqual(next);
    const original = history.undo(loaded);
    expect(original).toEqual(project);
    expect(history.redo(original)).toEqual(next);
  });
});
