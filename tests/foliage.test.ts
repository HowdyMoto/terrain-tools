import { describe, it, expect } from 'vitest';
import {
  createProject,
  generateTerrain,
  paintFoliage,
  populateFoliage,
  isHole,
} from '../src/core/terrain';
import { editFoliageModels, foliageModels } from '../src/core/foliage';
import {
  serializeFoliageBrush,
  importFoliageBrush,
} from '../src/core/foliage-preset';
import { parseProject, serializeProject } from '../src/core/serialization';

function mixed() {
  const p = createProject(32, 64);
  generateTerrain(p, 'flat');
  const b = p.brushes[0];
  b.materials = p.materials.map((m) => m.id);
  b.density = 1;
  const entries = editFoliageModels(b, p.foliage);
  Object.assign(entries[0], {
    weight: 3,
    minScale: 1,
    maxScale: 2,
    minRotation: -60,
    maxRotation: -30,
  });
  entries.push({
    ...entries[0],
    id: 'tufts',
    model: 'grass',
    weight: 1,
    minScale: 0.2,
    maxScale: 0.4,
    minRotation: 40,
    maxRotation: 80,
  });
  entries.push({ ...entries[0], id: 'disabled', model: 'boulder', weight: 0 });
  return p;
}

describe('mixed foliage brushes', () => {
  it('samples weighted models and their own transform ranges reproducibly', () => {
    const p = mixed(),
      brush = p.brushes[0];
    populateFoliage(p, brush.id, 19);
    const initial = p.foliage.map(({ id: _, ...f }) => f);
    const trees = p.foliage.filter((f) => f.modelId === 'primary').length;
    expect(trees / p.foliage.length).toBeGreaterThan(0.72);
    expect(trees / p.foliage.length).toBeLessThan(0.78);
    expect(p.foliage.some((f) => f.modelId === 'disabled')).toBe(false);
    for (const f of p.foliage) {
      const m = brush.models!.find((m) => m.id === f.modelId)!;
      expect(f.scale).toBeGreaterThanOrEqual(m.minScale);
      expect(f.scale).toBeLessThanOrEqual(m.maxScale);
      expect((f.rotation * 180) / Math.PI).toBeGreaterThanOrEqual(
        m.minRotation,
      );
      expect((f.rotation * 180) / Math.PI).toBeLessThanOrEqual(m.maxRotation);
    }
    populateFoliage(p, brush.id, 19);
    expect(p.foliage.map(({ id: _, ...f }) => f)).toEqual(initial);
    expect(parseProject(serializeProject(p))).toEqual(p);
  });
  it('keeps spacing across model types, population tile boundaries, and repeated paint strokes', () => {
    const p = mixed(),
      b = p.brushes[0];
    b.spacing = 2.5;
    p.holes.fill(1, 0, 32 * 4);
    populateFoliage(p, b.id);
    const before = p.foliage.length;
    paintFoliage(p, b.id, 0, 0, 28, 2, 91);
    expect(p.foliage.length).toBeGreaterThanOrEqual(before);
    expect(before).toBeGreaterThan(200);
    for (let i = 0; i < p.foliage.length; i++) {
      const a = p.foliage[i];
      expect(isHole(p, a.x, a.z)).toBe(false);
      for (let j = 0; j < i; j++) {
        const b = p.foliage[j];
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2.5);
      }
    }
  });
  it('respects allowed surfaces, disabled entries, and the total instance budget', () => {
    const p = mixed(),
      b = p.brushes[0];
    b.materials = ['snow'];
    expect(paintFoliage(p, b.id, 0, 0, 20, 1, 3)).toBe(0);
    b.materials = [];
    b.minWeight = 0;
    expect(paintFoliage(p, b.id, 0, 0, 20, 1, 3)).toBe(0);
    b.materials = ['grass', 'sand'];
    for (const m of b.models!) m.weight = 0;
    expect(populateFoliage(p, b.id)).toBe(0);
    b.models![1].weight = 1;
    expect(paintFoliage(p, b.id, 0, 0, 20, 1, 3, 7)).toBe(7);
    expect(p.foliage.every((f) => f.modelId === 'tufts')).toBe(true);
  });
  it('converts legacy placements without changing their transforms or model', () => {
    const p = createProject(16, 32),
      b = p.brushes[0];
    p.foliage = [
      { id: p.nextId++, brushId: b.id, x: 1, z: 2, scale: 1.3, rotation: 0.7 },
    ];
    const previous = { ...p.foliage[0] };
    const entries = editFoliageModels(b, p.foliage);
    expect(p.foliage[0]).toEqual({ ...previous, modelId: 'primary' });
    expect(entries[0].model).toBe('pine');
    entries[0].weight = 0;
    expect(p.foliage[0].modelId).toBe('primary');
    expect(parseProject(serializeProject(p))).toEqual(p);
    const legacy = createProject(8, 8);
    expect(parseProject(serializeProject(legacy))).toEqual(legacy);
    expect(foliageModels(legacy.brushes[0])[0].minRotation).toBe(-180);
  });
  it('rejects malformed mixtures and missing per-instance model references', () => {
    const cases = [
      (p: ReturnType<typeof mixed>) => {
        p.brushes[0].models = [];
      },
      (p: ReturnType<typeof mixed>) => {
        p.brushes[0].models![0].weight = -1;
      },
      (p: ReturnType<typeof mixed>) => {
        p.brushes[0].models![1].id = 'primary';
      },
      (p: ReturnType<typeof mixed>) => {
        p.brushes[0].models![0].model = 'missing';
      },
      (p: ReturnType<typeof mixed>) => {
        p.brushes[0].models![0].maxScale = 0.1;
      },
      (p: ReturnType<typeof mixed>) => {
        p.brushes[0].models![0].maxRotation = -90;
      },
      (p: ReturnType<typeof mixed>) => {
        p.brushes[0].spacing = -1;
      },
      (p: ReturnType<typeof mixed>) => {
        p.foliage[0].modelId = 'missing';
      },
      (p: ReturnType<typeof mixed>) => {
        delete p.foliage[0].modelId;
      },
    ];
    for (const mutate of cases) {
      const p = mixed();
      paintFoliage(p, 'pine', 0, 0, 4, 1, 3);
      mutate(p);
      expect(() => parseProject(serializeProject(p))).toThrow();
    }
  });
});

describe('portable foliage brushes', () => {
  it('preserves settings, remaps asset collisions, and matches changed material IDs by slot', () => {
    const p = mixed(),
      b = p.brushes[0];
    p.assets['asset-tree'] = {
      name: 'tree.glb',
      data: 'data:model/gltf-binary;base64,AAAA',
    };
    b.models![0].model = 'asset-tree';
    b.materials = ['grass', 'rock'];
    const preset = serializeFoliageBrush(p, b.id);
    const target = createProject(16, 32);
    target.assets['asset-tree'] = {
      name: 'existing.glb',
      data: 'data:model/gltf-binary;base64,AQAA',
    };
    target.materials[0].id = 'new-meadow';
    for (const brush of target.brushes)
      brush.materials = brush.materials.map((id) =>
        id === 'grass' ? 'new-meadow' : id,
      );
    const before = serializeProject(target);
    const next = importFoliageBrush(target, preset),
      imported = next.brushes.at(-1)!;
    expect(serializeProject(target)).toBe(before);
    expect(imported.materials).toEqual(['new-meadow', 'rock']);
    expect(imported.models![0].model).not.toBe('asset-tree');
    expect(next.assets[imported.models![0].model]).toEqual(
      p.assets['asset-tree'],
    );
    expect(next.assets['asset-tree']).toEqual(target.assets['asset-tree']);
    expect(imported.models!.slice(1)).toEqual(b.models!.slice(1));
    expect(parseProject(serializeProject(next))).toEqual(next);
    const again = importFoliageBrush(next, preset);
    expect(Object.keys(again.assets)).toHaveLength(2);
    expect(again.brushes.at(-1)!.id).not.toBe(imported.id);
  });
  it('exports only referenced models and rejects bad presets without mutating the document', () => {
    const p = mixed();
    p.assets.unused = {
      name: 'unused.glb',
      data: 'data:model/gltf-binary;base64,AAAA',
    };
    const preset = JSON.parse(serializeFoliageBrush(p, 'pine'));
    expect(preset.assets).toEqual({});
    preset.brush.models[0].model = 'unknown';
    const before = serializeProject(p);
    expect(() => importFoliageBrush(p, JSON.stringify(preset))).toThrow(
      'model reference',
    );
    expect(serializeProject(p)).toBe(before);
  });
});
