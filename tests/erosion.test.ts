import { describe, expect, it } from 'vitest';
import {
  createProject,
  effectiveHoles,
  applyBrush,
  generateTerrain,
} from '../src/core/terrain';
import {
  defaultErosionSettings,
  runErosion,
  erodeTerrain,
  erosionMask,
} from '../src/core/erosion';
import { parseProject, serializeProject } from '../src/core/serialization';
import { random } from '../src/core/math';
import type { BrushStroke } from '../src/core/types';

function slope() {
  const p = createProject(32, 64),
    rng = random(8),
    side = p.resolution + 1;
  for (let z = 0; z < side; z++)
    for (let x = 0; x < side; x++)
      p.heights[z * side + x] =
        25 * (1 - z / 32) + ((x - 16) / 8) ** 2 + rng() * 0.3 - 20;
  return p;
}
const settings = () => ({
  ...defaultErosionSettings(),
  mode: 'hydraulic' as const,
  rainfall: 4,
  maxDepth: 3,
});
const sum = (values: Float32Array) => values.reduce((a, b) => a + b, 0);

describe('terrain weathering', () => {
  it('transports thermal material downhill, conserves volume and does not invent extrema', () => {
    const p = createProject(32, 32);
    p.heights.fill(-5);
    p.heights[16 * 33 + 16] = 12;
    const old = p.heights.slice();
    const result = runErosion(p, {
      ...defaultErosionSettings(),
      mode: 'thermal',
      thermalIterations: 100,
      talus: 30,
    });
    expect(p.heights).toEqual(old);
    expect(result.heights[16 * 33 + 16]).toBeLessThan(4);
    expect(result.heights[16 * 33 + 17]).toBeGreaterThan(-5);
    expect(sum(result.heights)).toBeCloseTo(sum(old), 4);
    expect(result.heights.every((v) => v >= -5 && v <= 12)).toBe(true);
    expect(result.drainedVolume).toBe(0);
  });
  it('leaves stable slopes unchanged and treats zero rates and fully cut terrain as no-ops', () => {
    const p = createProject(16, 32);
    for (let i = 0; i < p.heights.length; i++) p.heights[i] = (i % 17) * 0.1;
    const thermal = {
      ...defaultErosionSettings(),
      mode: 'thermal' as const,
      talus: 20,
    };
    expect(runErosion(p, thermal).heights).toEqual(p.heights);
    const hill = slope();
    expect(runErosion(hill, { ...settings(), erosion: 0 }).heights).toEqual(
      hill.heights,
    );
    expect(runErosion(hill, { ...settings(), capacity: 0 }).heights).toEqual(
      hill.heights,
    );
    expect(runErosion(hill, { ...settings(), rainfall: 0 }).heights).toEqual(
      hill.heights,
    );
    expect(runErosion(hill, { ...settings(), maxDepth: 0 }).heights).toEqual(
      hill.heights,
    );
    hill.holes.fill(1);
    expect(runErosion(hill, defaultErosionSettings()).heights).toEqual(
      hill.heights,
    );
    generateTerrain(hill, 'flat');
    expect(runErosion(hill, settings()).heights).toEqual(hill.heights);
  });
  it('carves reproducible channels below sea level, deposits soil and accounts for drainage', () => {
    const p = slope(),
      before = p.heights.slice();
    const a = runErosion(p, settings()),
      b = runErosion(p, settings());
    expect(a).toEqual(b);
    expect(a.heights).not.toEqual(
      runErosion(p, { ...settings(), seed: 17 }).heights,
    );
    expect(p.heights).toEqual(before);
    expect(a.erodedVolume).toBeGreaterThan(10);
    expect(a.depositedVolume).toBeGreaterThan(1);
    expect(a.drainedVolume).toBeGreaterThan(0);
    expect(a.maxChange).toBeGreaterThan(0.1);
    expect(a.heights.some((h, i) => h > before[i] + 0.01)).toBe(true);
    expect(a.heights.some((h, i) => h < before[i] - 0.01 && h < 0)).toBe(true);
    expect(a.erodedVolume - a.depositedVolume).toBeCloseTo(a.drainedVolume, 7);
    const area = (p.size / p.resolution) ** 2;
    expect((sum(before) - sum(a.heights)) * area).toBeCloseTo(
      a.drainedVolume,
      2,
    );
    expect(
      a.heights.every(
        (h, i) =>
          Number.isFinite(h) &&
          h >= before[i] - 3.00001 &&
          Math.abs(h) <= p.size,
      ),
    ).toBe(true);
  });
  it('scales removal on steep slopes and keeps world-scale changes proportional', () => {
    const p = slope();
    const slow = runErosion(p, {
      ...settings(),
      erosion: 0.02,
      rainfall: 0.25,
    });
    const fast = runErosion(p, { ...settings(), erosion: 0.8, rainfall: 0.25 });
    expect(fast.erodedVolume).toBeGreaterThan(slow.erodedVolume * 4);
    const doubled = {
      ...p,
      size: p.size * 2,
      heights: Float32Array.from(p.heights, (v) => v * 2),
    };
    const normal = runErosion(p, settings());
    const scaled = runErosion(doubled, { ...settings(), maxDepth: 6 });
    expect(scaled.heights).toEqual(
      Float32Array.from(normal.heights, (v) => v * 2),
    );
    expect(scaled.erodedVolume).toBeCloseTo(normal.erodedVolume * 8, 5);
  });
  it('preserves painted holes, prop-cutout rims and the outer border through both processes', () => {
    const p = slope();
    p.holes[10 * 32 + 9] = 1;
    p.props.push({
      id: 1,
      model: 'portal',
      x: 5,
      z: 4,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 3,
    });
    const holes = effectiveHoles(p),
      mask = erosionMask(32, holes),
      before = p.heights.slice();
    const result = runErosion({ ...p, holes }, defaultErosionSettings());
    for (let i = 0; i < mask.length; i++)
      if (!mask[i]) expect(result.heights[i]).toBe(before[i]);
    expect(p.holes[10 * 32 + 9]).toBe(1);
    expect(result.heights).not.toEqual(before);
    expect(result.heights.every((h) => Math.abs(h) <= p.size)).toBe(true);
  });
  it('keeps thermal brush transport within its alpha, radius and effective hole mask', () => {
    const p = createProject(32, 32);
    p.heights.fill(0);
    p.heights[16 * 33 + 16] = 12;
    const stroke: BrushStroke = {
      tool: 'erode',
      x: 0,
      z: 0,
      radius: 5,
      strength: 2,
      falloff: 0.4,
      target: 0,
      talus: 25,
      material: 0,
      brushId: 'pine',
      seed: 42,
    };
    const before = p.heights.slice();
    applyBrush(p, {
      ...stroke,
      alpha: { width: 1, height: 1, values: new Float32Array([0]) },
    });
    expect(p.heights).toEqual(before);
    applyBrush(p, stroke);
    expect(p.heights[16 * 33 + 16]).toBeLessThan(12);
    expect(sum(p.heights)).toBeCloseTo(sum(before), 5);
    for (let z = 0; z <= 32; z++)
      for (let x = 0; x <= 32; x++)
        if (Math.hypot(x - 16, z - 16) >= 5)
          expect(p.heights[z * 33 + x]).toBe(before[z * 33 + x]);
    p.props.push({
      id: 1,
      model: 'portal',
      x: 0,
      z: 0,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 2,
    });
    const holeMask = erosionMask(32, effectiveHoles(p)),
      saved = p.heights.slice();
    applyBrush(p, stroke);
    for (let i = 0; i < saved.length; i++)
      if (!holeMask[i]) expect(p.heights[i]).toBe(saved[i]);
  });
  it('yields monotonic progress without changing the source if a job is abandoned', () => {
    const p = slope(),
      before = p.heights.slice();
    const job = erodeTerrain(p, defaultErosionSettings());
    const first = job.next();
    expect(first.done).toBe(false);
    expect(p.heights).toEqual(before);
    let previous = 0,
      next = first;
    while (!next.done) {
      expect(next.value.completed).toBeGreaterThan(previous);
      expect(next.value.completed).toBeLessThanOrEqual(next.value.total);
      previous = next.value.completed;
      next = job.next();
    }
    expect(p.heights).toEqual(before);
  });
  it('validates settings, persists them and rejects invalid terrain before mutation', () => {
    const p = slope();
    p.erosion = defaultErosionSettings();
    expect(parseProject(serializeProject(p))).toEqual(p);
    const invalid = JSON.parse(serializeProject(p));
    for (const [key, value] of [
      ['mode', 'ocean'],
      ['seed', 0.5],
      ['rainfall', 20],
      ['radius', 0],
      ['maxSteps', 500],
      ['inertia', 1],
      ['maxDepth', -2],
      ['talus', 90],
      ['evaporation', 0],
      ['thermalIterations', 0.5],
    ]) {
      invalid.erosion = { ...p.erosion, [key]: value };
      expect(() => parseProject(JSON.stringify(invalid))).toThrow('erosion');
    }
    expect(() =>
      runErosion({ ...p, holes: new Uint8Array(1) }, settings()),
    ).toThrow('terrain');
    const before = p.heights.slice();
    expect(() => runErosion(p, { ...settings(), erosion: NaN })).toThrow(
      'erosion',
    );
    expect(p.heights).toEqual(before);
    p.heights[0] = Infinity;
    expect(() => runErosion(p, settings())).toThrow('terrain');
  });
});
