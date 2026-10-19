import { describe, expect, it } from 'vitest';
import {
  createProject,
  generateTerrain,
  applyBrush,
  heightAt,
} from '../src/core/terrain';
import { builtInAlpha, defaultSculptSettings } from '../src/core/sculpt';
import { parseProject, serializeProject } from '../src/core/serialization';
import type { BrushStroke } from '../src/core/types';
import { History } from '../src/core/history';
const stroke = (overrides: Partial<BrushStroke> = {}): BrushStroke => ({
  tool: 'stamp',
  x: 0,
  z: 0,
  radius: 4,
  strength: 1,
  falloff: 0.01,
  target: 10,
  material: 0,
  brushId: 'pine',
  seed: 42,
  alpha: { width: 2, height: 2, values: new Float32Array([0, 1, 0, 1]) },
  ...overrides,
});
describe('alpha sculpting', () => {
  it('rotates asymmetric stamps in terrain Y and supports add, subtract and set modes', () => {
    const p = createProject(32, 32);
    generateTerrain(p, 'flat');
    applyBrush(p, stroke());
    expect(heightAt(p, 2, 0)).toBeCloseTo(7.5);
    expect(heightAt(p, -2, 0)).toBeCloseTo(2.5);
    generateTerrain(p, 'flat');
    applyBrush(p, stroke({ rotation: Math.PI / 2 }));
    expect(heightAt(p, 0, -2)).toBeCloseTo(7.5);
    expect(heightAt(p, 0, 2)).toBeCloseTo(2.5);
    applyBrush(p, stroke({ rotation: Math.PI / 2, stampMode: 'subtract' }));
    expect(heightAt(p, 0, -2)).toBeCloseTo(0);
    applyBrush(p, stroke({ stampMode: 'set', stampBase: 3 }));
    expect(heightAt(p, 0, 0)).toBeCloseTo(8);
    applyBrush(p, stroke({ stampMode: 'set', stampBase: 3 }));
    expect(heightAt(p, 0, 0)).toBeCloseTo(8);
  });
  it('covers rotated square corners and masks ordinary sculpt brushes', () => {
    const p = createProject(64, 32);
    generateTerrain(p, 'flat');
    const white = { width: 1, height: 1, values: new Float32Array([1]) };
    applyBrush(p, stroke({ radius: 4, rotation: Math.PI / 4, alpha: white }));
    expect(heightAt(p, 5, 0)).toBeGreaterThan(0);
    expect(heightAt(p, 6, 0)).toBe(0);
    generateTerrain(p, 'flat');
    applyBrush(
      p,
      stroke({
        tool: 'raise',
        alpha: { width: 1, height: 1, values: new Float32Array([0]) },
      }),
    );
    expect(p.heights.every((h) => h === 0)).toBe(true);
    applyBrush(p, stroke({ tool: 'raise', alpha: white, strength: 0.25 }));
    expect(heightAt(p, 0, 0)).toBeCloseTo(0.25);
  });
  it('provides distinct bounded procedural alphas with faded boundaries', () => {
    for (const kind of ['round', 'ridge', 'crater'] as const) {
      const alpha = builtInAlpha(kind);
      expect(alpha.values.every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(alpha.values[0]).toBe(0);
      expect(Math.max(...alpha.values)).toBeGreaterThan(0.4);
    }
    expect(builtInAlpha('round').values).not.toEqual(
      builtInAlpha('ridge').values,
    );
    expect(builtInAlpha('crater').values[64 * 129 + 64]).toBeLessThan(0.001);
  });
  it('persists custom alpha precision and makes sculpt transactions undoable', () => {
    const p = createProject(8, 16);
    generateTerrain(p, 'flat');
    p.sculpt = {
      ...defaultSculptSettings(),
      alphaKind: 'custom',
      alpha: stroke().alpha,
      alphaName: 'slope.png',
    };
    const history = new History();
    history.checkpoint(p);
    const old = p.heights.slice();
    applyBrush(p, stroke());
    const loaded = parseProject(serializeProject(p));
    expect(loaded).toEqual(p);
    expect(loaded.sculpt!.alpha!.values).toBeInstanceOf(Float32Array);
    expect(history.undo(p).heights).toEqual(old);
    const invalid = JSON.parse(serializeProject(p));
    invalid.sculpt.alpha.values[0] = 2;
    expect(() => parseProject(JSON.stringify(invalid))).toThrow('buffer');
    delete invalid.sculpt.alpha;
    expect(() => parseProject(JSON.stringify(invalid))).toThrow('missing');
  });
});
