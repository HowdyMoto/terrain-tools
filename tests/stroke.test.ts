import { describe, it, expect } from 'vitest';
import { StrokeSampler } from '../src/core/stroke';
describe('stroke sampling', () => {
  const simulate = (fps: number) => {
    const sampler = new StrokeSampler();
    const dabs = [];
    for (let frame = 0; frame <= fps; frame++) {
      const time = frame / fps;
      dabs.push(
        ...sampler.sample({ x: time * 20, y: 0, z: 0 }, time, 0.5, 0.5),
      );
    }
    return dabs;
  };
  it('matches fixed-time doses and positions at 30, 60 and 144 frames per second', () => {
    const reference = simulate(30);
    for (const fps of [60, 144]) {
      const result = simulate(fps);
      expect(result).toHaveLength(reference.length);
      for (let i = 0; i < result.length; i++) {
        expect(result[i].point.x).toBeCloseTo(reference[i].point.x, 8);
        expect(result[i].dose).toBeCloseTo(reference[i].dose, 8);
        expect(result[i].first).toBe(reference[i].first);
      }
    }
    expect(reference.reduce((sum, d) => sum + d.dose, 0)).toBeCloseTo(8.5);
  });
  it('creates the first transaction on the first valid hit and never bridges missing terrain', () => {
    const sampler = new StrokeSampler();
    expect(sampler.sample(null, 0, 1, 1)).toEqual([]);
    expect(sampler.sample({ x: 0, y: 0, z: 0 }, 0.2, 1, 1)[0].first).toBe(true);
    sampler.sample(null, 0.4, 1, 1);
    const reentry = sampler.sample({ x: 100, y: 0, z: 0 }, 0.6, 1, 1);
    expect(reentry).toHaveLength(1);
    expect(reentry[0].first).toBe(false);
    expect(reentry[0].point.x).toBe(100);
  });
  it('places one stamp per gesture and applies actual pen pressure', () => {
    const sampler = new StrokeSampler();
    expect(sampler.sample({ x: 0, y: 0, z: 0 }, 0, 0, 1, true)).toEqual([]);
    expect(
      sampler.sample({ x: 0, y: 0, z: 0 }, 0.1, 0.2, 1, true)[0],
    ).toMatchObject({ first: true, dose: 0.2 });
    expect(sampler.sample({ x: 5, y: 0, z: 0 }, 1, 1, 1, true)).toEqual([]);
    sampler.reset();
    expect(sampler.sample({ x: 5, y: 0, z: 0 }, 2, 1, 1, true)[0].first).toBe(
      true,
    );
  });
});
