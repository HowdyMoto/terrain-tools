import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import { editFoliageModels } from '../src/core/foliage';
import { FoliageInteraction } from '../src/core/interaction';
import { serializeProject, parseProject } from '../src/core/serialization';
import {
  serializeProjectPackage,
  parseProjectPackage,
} from '../src/core/project-package';
import {
  serializeFoliageBrush,
  importFoliageBrush,
} from '../src/core/foliage-preset';
import { TerrainScene } from '../src/runtime/terrain-scene';

function fixture() {
  const project = createProject(32, 64);
  project.heights.fill(0);
  const grass = editFoliageModels(project.brushes[0], project.foliage)[0];
  Object.assign(grass, {
    model: 'grass',
    crush: 0.7,
    wind: 1,
    flexibility: { source: 'height', start: 0, end: 1, exponent: 2 },
    interaction: { enabled: true, radius: 10, recovery: 2 },
  });
  const tree = {
    ...structuredClone(grass),
    id: 'tree',
    model: 'pine',
    crush: 1,
    interaction: { enabled: false, radius: 10, recovery: 8 },
  };
  project.brushes[0].models!.push(tree);
  project.foliage = [grass, tree].map((model, i) => ({
    id: i + 1,
    brushId: project.brushes[0].id,
    modelId: model.id,
    x: 8,
    z: 0,
    scale: 1,
    rotation: 0,
  }));
  project.nextId = 3;
  project.interaction.enabled = false;
  return { project, grass, tree };
}

describe('per-model foliage contact response', () => {
  it('uses independent radii and recovery, skips rigid models, and keeps the legacy fallback', () => {
    const { project } = fixture();
    const contact = new FoliageInteraction(2);
    contact.setInstances([
      ...project.foliage,
      { ...project.foliage[0], id: 3, x: 1 },
    ]);
    const overrides = new Map([
      [1, { enabled: true, radius: 10, strength: 1, recovery: 2 }],
      [2, { enabled: false, radius: 10, strength: 1, recovery: 8 }],
    ]);
    const legacy = { enabled: true, radius: 4, strength: 0.4, recovery: 4 };
    const resolve = (id: number) => overrides.get(id);
    contact.update(
      0,
      [{ x: 0, z: 0, radius: 2, strength: 1 }],
      legacy,
      resolve,
      10,
    );
    expect(contact.amount(1)).toBeCloseTo(0.2); // Beyond the emitter's legacy radius.
    expect(contact.amount(2)).toBe(0);
    expect(contact.amount(3)).toBeCloseTo(0.2);
    contact.update(2, [], legacy, resolve, 10);
    expect(contact.amount(1)).toBeCloseTo(0.2 * Math.exp(-1));
    expect(contact.amount(3)).toBeCloseTo(0.2 * Math.exp(-0.5));
    overrides.get(1)!.enabled = false;
    contact.update(0, [], legacy, resolve, 0);
    expect(contact.amount(1)).toBe(0);
    expect(contact.amount(3)).toBeGreaterThan(0);
  });

  it('persists overrides in projects and portable brushes while accepting unchanged legacy models', async () => {
    const { project, grass } = fixture();
    expect(parseProject(serializeProject(project))).toEqual(project);
    expect(
      parseProjectPackage(await serializeProjectPackage(project).arrayBuffer()),
    ).toEqual(project);
    const imported = importFoliageBrush(
      createProject(32, 64),
      serializeFoliageBrush(project, project.brushes[0].id),
    );
    expect(
      imported.brushes.at(-1)!.models!.map((model) => model.interaction),
    ).toEqual(project.brushes[0].models!.map((model) => model.interaction));
    for (const invalid of [
      null,
      { enabled: 'yes', radius: 1, recovery: 2 },
      { enabled: true, radius: 0, recovery: 2 },
      { enabled: true, radius: 1, recovery: -1 },
    ]) {
      (grass as unknown as { interaction: unknown }).interaction = invalid;
      expect(() => parseProject(serializeProject(project))).toThrow();
    }
    delete grass.interaction;
    expect(
      parseProject(serializeProject(project)).brushes[0].models![0].interaction,
    ).toBeUndefined();
  });

  it('renders grass contact with global legacy response disabled and preserves settings through candidate disposal and apply', () => {
    const { project, grass, tree } = fixture();
    const scene = new TerrainScene(project);
    scene.rebuildFoliage();
    const amount = (id: string) => {
      const mesh = scene.foliage.children.find(
        (child) => child.userData.modelId === id,
      ) as THREE.InstancedMesh;
      return mesh.geometry.getAttribute('terrainContact').getX(0);
    };
    scene.update(0.01, [{ x: 0, z: 0, radius: 1, strength: 1 }]);
    expect(amount(grass.id)).toBeCloseTo(0.14);
    expect(amount(tree.id)).toBe(0);
    const candidate = parseProject(serializeProject(project));
    candidate.brushes[0].models![0].interaction!.enabled = false;
    candidate.brushes[0].models![1].interaction!.enabled = true;
    scene.foliage.prepare(candidate).dispose();
    scene.update(2);
    expect(amount(grass.id)).toBeCloseTo(0.14 * Math.exp(-1));
    expect(amount(tree.id)).toBe(0);
    scene.foliage.apply(scene.foliage.prepare(candidate));
    scene.update(0.01, [{ x: 0, z: 0, radius: 1, strength: 1 }]);
    expect(amount(grass.id)).toBe(0);
    expect(amount(tree.id)).toBeCloseTo(0.2);
    scene.dispose();
  });
});
