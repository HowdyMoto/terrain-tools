import { FoliageInteraction } from '../src/core/interaction';
import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  buildMeshData,
  createProject,
  effectiveHoles,
  generateTerrain,
  heightAt,
  isHole,
  materialWeights,
  paintFoliage,
  populateFoliage,
} from '../src/core/terrain';
import { History } from '../src/core/history';
import { parseProject, serializeProject } from '../src/core/serialization';
import type { BrushStroke } from '../src/core/types';
const flat = () => {
  const p = createProject(16, 32);
  generateTerrain(p, 'flat');
  return p;
};
const stroke = (
  tool: BrushStroke['tool'],
  overrides: Partial<BrushStroke> = {},
): BrushStroke => ({
  tool,
  x: 0,
  z: 0,
  radius: 5,
  strength: 2,
  falloff: 0.5,
  target: 10,
  material: 1,
  brushId: 'pine',
  seed: 13,
  ...overrides,
});
describe('terrain topology', () => {
  it('uses upward winding and exactly two triangles per intact cell', () => {
    const p = flat(),
      m = buildMeshData(p);
    expect(m.indices.length).toBe(16 * 16 * 6);
    const [a, b, c] = Array.from(m.indices)
      .slice(0, 3)
      .map((i) => Array.from(m.positions).slice(i * 3, i * 3 + 3));
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    expect(ny).toBeGreaterThan(0);
  });
  it('samples the actual triangle surface, not a bilinear approximation', () => {
    const p = flat(),
      i = 8 * 17 + 8;
    p.heights[i] = 0;
    p.heights[i + 1] = 0;
    p.heights[i + 17] = 0;
    p.heights[i + 18] = 10;
    expect(heightAt(p, 0.5, 0.5)).toBe(0);
    expect(heightAt(p, 1.5, 1.5)).toBe(5);
  });
  it('removes visual and collision triangles for every hole, then restores them', () => {
    const p = flat();
    applyBrush(p, stroke('hole'));
    const count = p.holes.reduce((a, b) => a + b, 0);
    expect(count).toBeGreaterThan(0);
    expect(buildMeshData(p).indices.length).toBe((256 - count) * 6);
    expect(isHole(p, 1, 1)).toBe(true);
    applyBrush(p, stroke('fill'));
    expect(buildMeshData(p).indices.length).toBe(256 * 6);
  });
  it('keeps prop cutouts independent of artist holes and overlapping props', () => {
    const p = flat();
    p.holes[0] = 1;
    p.props.push(
      {
        id: 1,
        model: 'portal',
        x: 0,
        z: 0,
        yOffset: 0,
        rotation: 0,
        scale: 1,
        cutHole: true,
        holeRadius: 5,
      },
      {
        id: 2,
        model: 'portal',
        x: 0,
        z: 0,
        yOffset: 0,
        rotation: 0,
        scale: 1,
        cutHole: true,
        holeRadius: 5,
      },
    );
    const h = effectiveHoles(p);
    p.props.shift();
    expect(effectiveHoles(p)).toEqual(h);
    p.props = [];
    expect(effectiveHoles(p).reduce((a, b) => a + b, 0)).toBe(1);
    expect(p.holes[0]).toBe(1);
  });
  it('produces identical positions along chunk boundaries', () => {
    const p = createProject(64, 64),
      a = buildMeshData(p, 0, 0, 32, 32),
      b = buildMeshData(p, 32, 0, 32, 32);
    for (let z = 0; z <= 32; z++)
      expect(
        Array.from(a.positions.slice((z * 33 + 32) * 3, (z * 33 + 33) * 3)),
      ).toEqual(Array.from(b.positions.slice(z * 33 * 3, z * 33 * 3 + 3)));
  });
});
describe('sculpting', () => {
  it('raises and lowers only inside the brush with a soft edge', () => {
    const p = flat();
    applyBrush(p, stroke('raise'));
    expect(heightAt(p, 0, 0)).toBe(2);
    expect(heightAt(p, 12, 12)).toBe(0);
    expect(heightAt(p, 4, 0)).toBeLessThan(2);
    applyBrush(p, stroke('lower'));
    expect(heightAt(p, 0, 0)).toBeCloseTo(0);
  });
  it('smooths an isolated spike and converges flatten to target', () => {
    const p = flat();
    p.heights[8 * 17 + 8] = 30;
    applyBrush(p, stroke('smooth'));
    expect(heightAt(p, 0, 0)).toBeLessThan(30);
    for (let i = 0; i < 30; i++) applyBrush(p, stroke('flatten'));
    expect(heightAt(p, 0, 0)).toBeCloseTo(10, 3);
  });
  it('generates repeatable noise and landscapes from a seed', () => {
    const a = flat(),
      b = flat();
    applyBrush(a, stroke('noise'));
    applyBrush(b, stroke('noise'));
    expect(a.heights).toEqual(b.heights);
    expect(createProject(16, 32, 77).heights).toEqual(
      createProject(16, 32, 77).heights,
    );
    expect(createProject(16, 32, 78).heights).not.toEqual(
      createProject(16, 32, 77).heights,
    );
  });
});
describe('surfaces and ecosystems', () => {
  it('normalizes automatic weights with an explicit fallback outside all rules', () => {
    const p = flat();
    for (const m of p.materials) {
      m.minHeight = 100;
      m.maxHeight = 200;
    }
    expect(materialWeights(p, 0, 0)).toEqual([1, 0, 0, 0]);
  });
  it('blends painted overrides without losing normalization', () => {
    const p = flat();
    for (let i = 0; i < 30; i++) applyBrush(p, stroke('material'));
    const weights = materialWeights(p, 0, 0);
    expect(weights[1]).toBeGreaterThan(0.999);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it('rejects foliage on disallowed materials, holes, and outside terrain', () => {
    const p = flat();
    p.brushes[0].materials = ['snow'];
    expect(paintFoliage(p, 'pine', 0, 0, 10, 1, 42)).toBe(0);
    p.brushes[0].materials = ['grass', 'sand'];
    p.holes.fill(1);
    expect(paintFoliage(p, 'pine', 0, 0, 10, 1, 42)).toBe(0);
    p.holes.fill(0);
    expect(paintFoliage(p, 'pine', 100, 100, 10, 1, 42)).toBe(0);
  });
  it('respects per-model scale/rotation variance and deterministic distribution', () => {
    const p = flat();
    p.brushes[0].materials = ['grass', 'sand'];
    populateFoliage(p, 'pine');
    const first = p.foliage.map(({ id: _, ...rest }) => rest);
    expect(first.length).toBeGreaterThan(0);
    populateFoliage(p, 'pine');
    expect(p.foliage.map(({ id: _, ...rest }) => rest)).toEqual(first);
    for (const f of p.foliage) {
      expect(f.scale).toBeGreaterThanOrEqual(0.7);
      expect(f.scale).toBeLessThanOrEqual(1.5);
      expect(Math.abs(f.rotation)).toBeLessThanOrEqual(Math.PI);
    }
  });
});
describe('project persistence', () => {
  it('round-trips all terrain buffers, holes, materials, and foliage', () => {
    const p = flat();
    applyBrush(p, stroke('raise'));
    applyBrush(p, stroke('hole'));
    p.materials[0].textures.albedo = 'data:image/png;base64,test';
    expect(parseProject(serializeProject(p))).toEqual(p);
  });
  it('rejects malformed dimensions and buffers', () => {
    const p = flat();
    const data = JSON.parse(serializeProject(p));
    data.resolution = 100000;
    expect(() => parseProject(JSON.stringify(data))).toThrow('dimensions');
    data.resolution = 16;
    data.heights[0] = null;
    expect(() => parseProject(JSON.stringify(data))).toThrow('buffer');
  });
  it('undoes and redoes separate transactions without sharing mutable buffers', () => {
    let p = flat();
    const h = new History();
    h.checkpoint(p);
    applyBrush(p, stroke('raise'));
    p = h.undo(p);
    expect(heightAt(p, 0, 0)).toBe(0);
    p = h.redo(p);
    expect(heightAt(p, 0, 0)).toBe(2);
    h.checkpoint(p);
    p.heights[0] = 100;
    expect(h.undo(p).heights[0]).toBe(0);
    expect(h.redo(p).heights[0]).toBe(100);
  });
});

describe('untrusted project metadata', () => {
  const edit = (change: (p: Record<string, any>) => void) => {
    const data = JSON.parse(serializeProject(flat()));
    change(data);
    return () => parseProject(JSON.stringify(data));
  };
  it('rejects invalid names, identifiers, empty brushes, and broken model references', () => {
    expect(
      edit((p) => {
        p.name = null;
      }),
    ).toThrow('project name');
    expect(
      edit((p) => {
        p.materials[0].id = 'bad" onclick="x';
      }),
    ).toThrow('identifier');
    expect(
      edit((p) => {
        p.brushes = [];
      }),
    ).toThrow('foliage brush');
    expect(
      edit((p) => {
        p.brushes[0].model = 'missing';
      }),
    ).toThrow('model reference');
  });
  it('rejects nonbinary holes, unnormalized paint, and invalid environment ranges', () => {
    expect(
      edit((p) => {
        p.holes[0] = 0.5;
      }),
    ).toThrow('buffer');
    expect(
      edit((p) => {
        p.paint[0] = 1;
        p.paint[1] = 1;
      }),
    ).toThrow('Paint weights');
    expect(
      edit((p) => {
        p.interaction.recovery = -1;
      }),
    ).toThrow('recovery time');
  });
  it('rejects external texture URLs and stale or duplicate instance identifiers', () => {
    expect(
      edit((p) => {
        p.materials[0].textures.albedo = 'https://example.com/image.png';
      }),
    ).toThrow('embedded');
    expect(
      edit((p) => {
        p.foliage = [
          { id: 1, brushId: 'pine', x: 0, z: 0, scale: 1, rotation: 0 },
        ];
      }),
    ).toThrow('Next identifier');
  });
});

describe('engine-independent foliage interaction', () => {
  const instances = [
    { id: 1, brushId: 'grass', x: 0, z: 0, scale: 1, rotation: 0 },
    { id: 2, brushId: 'grass', x: 20, z: 20, scale: 1, rotation: 0 },
  ];
  const settings = { enabled: true, radius: 4, strength: 1, recovery: 2 };
  it('compresses only nearby foliage and recovers consistently across frame rates', () => {
    const a = new FoliageInteraction(),
      b = new FoliageInteraction();
    a.setInstances(instances);
    b.setInstances(instances);
    for (const field of [a, b]) {
      field.update(0, [{ x: 0, z: 0, radius: 4, strength: 1 }], settings);
      expect(field.amount(1)).toBe(1);
      expect(field.amount(2)).toBe(0);
    }
    for (let i = 0; i < 60; i++) a.update(1 / 60, [], settings);
    for (let i = 0; i < 30; i++) b.update(1 / 30, [], settings);
    expect(a.amount(1)).toBeCloseTo(Math.exp(-0.5), 8);
    expect(a.amount(1)).toBeCloseTo(b.amount(1), 8);
  });
  it('clears compression when disabled and removes stale instance state', () => {
    const field = new FoliageInteraction();
    field.setInstances(instances);
    field.update(0, [{ x: 0, z: 0, radius: 4, strength: 1 }], settings);
    expect(field.update(0, [], { ...settings, enabled: false }).has(1)).toBe(
      true,
    );
    expect(field.amount(1)).toBe(0);
    field.update(0, [{ x: 0, z: 0, radius: 4, strength: 1 }], settings);
    field.setInstances([]);
    expect(field.amount(1)).toBe(0);
  });
});
