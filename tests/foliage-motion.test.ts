import { describe, expect, it } from 'vitest';
import { FoliageMotionHistory } from '../src/render/foliage-motion';

const matrices = (...positions: number[]) => {
  const data = new Float32Array(positions.length * 16);
  positions.forEach((x, i) => {
    for (const at of [0, 5, 10, 15]) data[i * 16 + at] = 1;
    data[i * 16 + 12] = x;
  });
  return data;
};
const wind = (time: number) => [time, 2, 1.5, 0.4, 1, 0];
describe('foliage rendered motion history', () => {
  it('matches compacted plants by ID and rejects newly appearing coverage', () => {
    const history = new FoliageMotionHistory(3),
      epoch = {};
    history.prepare(
      { serial: 1, epoch },
      [10, 20],
      matrices(1, 2),
      1,
      new Float32Array([0.1, 0.2]),
      1,
      wind(1),
    );
    expect([...history.states.slice(0, 4)]).toEqual([
      expect.closeTo(0.1),
      0,
      expect.closeTo(0.2),
      0,
    ]);
    history.prepare(
      { serial: 2, epoch },
      [20, 30],
      matrices(22, 3),
      2,
      new Float32Array([0.8, 0.3]),
      2,
      wind(2),
    );
    expect(history.matrices[12]).toBe(2);
    expect(history.matrices[28]).toBe(3);
    expect([...history.states.slice(0, 4)]).toEqual([
      expect.closeTo(0.2),
      1,
      expect.closeTo(0.3),
      0,
    ]);
    expect(history.wind.x).toBe(1);
  });
  it('uses the last drawn pose across skipped simulation updates and all composition passes', () => {
    const history = new FoliageMotionHistory(1),
      epoch = {},
      ids = [1];
    history.prepare(
      { serial: 1, epoch },
      ids,
      matrices(1),
      1,
      undefined,
      0,
      wind(1),
    );
    history.prepare(
      { serial: 2, epoch },
      ids,
      matrices(4),
      4,
      undefined,
      0,
      wind(4),
    );
    expect(history.matrices[12]).toBe(1);
    expect(history.wind.x).toBe(1);
    const version = history.version;
    history.prepare(
      { serial: 2, epoch },
      ids,
      matrices(4),
      4,
      undefined,
      0,
      wind(4),
    );
    expect(history.version).toBe(version);
    expect(history.matrices[12]).toBe(1);
    history.prepare(
      { serial: 3, epoch },
      ids,
      matrices(4),
      4,
      undefined,
      0,
      wind(4),
    );
    expect(history.matrices[12]).toBe(4);
    expect(history.wind.x).toBe(4);
    const settled = history.version;
    history.prepare(
      { serial: 4, epoch },
      ids,
      matrices(4),
      4,
      undefined,
      0,
      wind(4),
    );
    expect(history.version).toBe(settled);
  });
  it('invalidates stale history after culling, reset, or camera history replacement', () => {
    const history = new FoliageMotionHistory(1),
      epoch = {},
      ids = [1];
    history.prepare(
      { serial: 1, epoch },
      ids,
      matrices(1),
      1,
      undefined,
      0,
      wind(1),
    );
    history.prepare(
      { serial: 2, epoch },
      ids,
      matrices(1),
      1,
      undefined,
      0,
      wind(2),
    );
    expect(history.states[1]).toBe(1);
    history.prepare(
      { serial: 5, epoch },
      ids,
      matrices(7),
      2,
      undefined,
      0,
      wind(5),
    );
    expect(history.states[1]).toBe(0);
    expect(history.matrices[12]).toBe(7);
    expect(history.wind.x).toBe(5);
    history.prepare(
      { serial: 6, epoch: {} },
      ids,
      matrices(7),
      2,
      undefined,
      0,
      wind(6),
    );
    expect(history.states[1]).toBe(0);
    expect(history.wind.x).toBe(6);
  });
});
