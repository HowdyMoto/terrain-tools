import { describe, expect, it } from 'vitest';
import { History } from '../src/core/history';
import { SnapshotStore } from '../src/core/snapshots';
import { createProject } from '../src/core/terrain';
import type { TerrainProject } from '../src/core/types';

const plants = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    brushId: 'grass',
    x: i,
    z: -i,
    scale: 1,
    rotation: 0,
  }));

describe('shared terrain history', () => {
  it('matches full copies across mixed edits, removals, reorders, and terrain resizing', () => {
    const history = new History(80),
      states: TerrainProject[] = [];
    let project = createProject(32, 64);
    project.foliage = plants(24);
    project.assets.marker = {
      name: 'marker',
      data: 'data:model/gltf-binary;base64,' + 'a'.repeat(2000),
    };
    project.sculpt = {
      alphaKind: 'custom',
      alpha: {
        width: 2,
        height: 2,
        values: new Float32Array([0, 0.25, 0.5, 1]),
      },
      rotation: 0,
      stampHeight: 3,
      stampBase: 0,
      stampMode: 'add',
      pressure: true,
    };
    for (let step = 0; step < 30; step++) {
      history.checkpoint(project);
      states.push(structuredClone(project));
      project.heights[step * 19] += step / 3;
      project.paint[step * 20] = 0.5;
      project.holes[step] = step % 2;
      project.name = 'Edit ' + step;
      if (step % 3 === 0) project.foliage.reverse();
      if (step % 5 === 0) project.foliage.splice(2, 1);
      if (project.foliage[step % project.foliage.length])
        project.foliage[step % project.foliage.length].scale += 0.1;
      if (step === 8) {
        delete project.assets.marker;
        project.assets.other = { name: 'other', data: 'b'.repeat(2000) };
        project.materials[0].textures.albedo = 'c'.repeat(500);
      }
      if (step === 12) {
        delete project.materials[0].textures.albedo;
        project.materials[0].textures.normal = 'd'.repeat(500);
        delete project.sculpt;
      }
      if (step === 20) project = createProject(64, 128);
    }
    const final = structuredClone(project);
    for (let step = states.length - 1; step >= 0; step--) {
      project = history.undo(project);
      expect(project).toEqual(states[step]);
    }
    expect(history.canUndo).toBe(false);
    for (let step = 1; step < states.length; step++) {
      project = history.redo(project);
      expect(project).toEqual(states[step]);
    }
    project = history.redo(project);
    expect(project).toEqual(final);
    expect(history.canRedo).toBe(false);
  });

  it('retains one copy of unchanged plants, payloads and buffers and only changed 64 KiB blocks', () => {
    const project = createProject(256, 256),
      history = new History(32);
    project.foliage = plants(3000);
    project.assets.marker = { name: 'marker', data: 'a'.repeat(1_000_000) };
    history.checkpoint(project);
    const originalBytes = history.stats.retainedBytes;
    for (let i = 0; i < 10; i++) history.checkpoint(project);
    expect(history.stats.retainedBytes).toBeLessThan(originalBytes + 1024);
    for (let i = 0; i < 10; i++) {
      project.heights[i * 100] += 1;
      history.checkpoint(project);
    }
    expect(history.stats.retainedBytes - originalBytes).toBeLessThan(
      10 * 70_000,
    );
    const beforeRemoval = history.stats.retainedBytes;
    project.foliage.shift();
    history.checkpoint(project);
    expect(history.stats.retainedBytes - beforeRemoval).toBeLessThan(35_000);
    history.clear();
    expect(history.stats.retainedBytes).toBe(0);
    expect(history.canUndo || history.canRedo).toBe(false);
  });

  it('returns independent inspection and restoration copies, including nested objects', () => {
    const project = createProject(16, 32),
      history = new History();
    project.foliage = plants(2);
    history.checkpoint(project);
    const before = structuredClone(project),
      inspect = history.undoTarget!;
    inspect.heights[0] = 9;
    inspect.foliage[0].x = 9;
    inspect.materials[0].textures.normal = 'changed';
    const restored = history.undo(project);
    expect(restored).toEqual(before);
    project.heights[1] = 99;
    project.foliage[1].x = 99;
    expect(history.redo(restored)).toEqual(before);
    restored.heights[1] = 3;
    expect(history.undoTarget).toEqual(before);
  });

  it('preserves exact float bits, typed-array offsets, short final blocks, and independent fields', () => {
    const store = new SnapshotStore();
    const backing = new Uint8Array(65542);
    backing[65540] = 17;
    const values = new Float32Array([
      0,
      -0,
      1 / 3,
      Number.MIN_VALUE,
      Infinity,
      NaN,
    ]);
    const source = { a: backing.subarray(1, 65541), b: values, c: values };
    const snapshot = store.capture(source);
    store.retain(snapshot);
    const restored = store.restore<typeof source>(snapshot);
    expect(restored.a).toEqual(source.a);
    expect(new Uint8Array(restored.b.buffer)).toEqual(
      new Uint8Array(values.buffer),
    );
    restored.b[0] = 7;
    expect(restored.c[0]).toBe(0);
    backing[65540] = 99;
    expect(store.restore<typeof source>(snapshot).a.at(-1)).toBe(17);
    store.release(snapshot);
    expect(store.bytes).toBe(0);
  });

  it('counts and evicts shared assets accurately across branches, reuse, and clearing', () => {
    const project = createProject(16, 32),
      history = new History({ limit: 2, byteLimit: 20_000_000 });
    project.assets.a = { name: 'a', data: 'a'.repeat(500_000) };
    project.assets.alias = { name: 'alias', data: project.assets.a.data };
    history.checkpoint(project);
    expect(history.stats.retainedBytes).toBeLessThan(1_100_000);
    project.assets.a.data = 'b'.repeat(500_000);
    history.checkpoint(project);
    delete project.assets.alias;
    project.assets.a.data = 'c'.repeat(500_000);
    history.checkpoint(project);
    expect(history.stats.retainedBytes).toBeGreaterThan(3_000_000);
    history.checkpoint(project);
    expect(history.stats.retainedBytes).toBeLessThan(1_100_000);
    let current = history.undo(project);
    current.assets.a.data = 'd'.repeat(500_000);
    history.checkpoint(current);
    expect(history.canRedo).toBe(false);
    expect(history.stats.retainedBytes).toBeLessThan(2_100_000);
    current = history.undo(current);
    expect(current.assets.a.data).toBe('d'.repeat(500_000));
    history.clear();
    expect(history.stats.retainedBytes).toBe(0);
  });

  it('enforces count and byte budgets, reports oversized nearest states, and allows history to be disabled', () => {
    const project = createProject(16, 32),
      probe = new History();
    probe.checkpoint(project);
    const budget = probe.stats.retainedBytes + 1500;
    const history = new History({ limit: 4, byteLimit: budget });
    for (let i = 0; i < 12; i++) {
      project.heights.fill(i);
      history.checkpoint(project);
    }
    expect(history.stats.undoCount).toBe(1);
    expect(history.stats.retainedBytes).toBeLessThanOrEqual(budget);
    expect(history.stats.evictedCount).toBe(11);
    expect(history.undo(project).heights[0]).toBe(11);
    expect(history.redo(project).heights[0]).toBe(11);
    const repeated = new History({ limit: 1000000, byteLimit: budget });
    for (let i = 0; i < 100; i++) repeated.checkpoint(project);
    expect(repeated.stats.retainedBytes).toBeLessThanOrEqual(budget);
    expect(repeated.stats.undoCount).toBeLessThan(100);
    expect(repeated.stats.evictedCount).toBeGreaterThan(0);
    const oversized = new History({ byteLimit: 1 });
    oversized.checkpoint(project);
    expect(oversized.stats.overBudget).toBe(true);
    expect(oversized.canUndo).toBe(true);
    oversized.clear();
    expect(oversized.stats.overBudget).toBe(false);
    const disabled = new History(0);
    disabled.checkpoint(project);
    expect(disabled.stats.retainedBytes).toBe(0);
    expect(disabled.undo(project)).toBe(project);
    for (const options of [
      -1,
      1.5,
      NaN,
      { byteLimit: 0 },
      { byteLimit: Infinity },
    ])
      expect(() => new History(options)).toThrow('limits');
  });

  it('keeps history unchanged until a prepared restore commits and returns the exact prepared project', () => {
    const project = createProject(16, 32),
      history = new History();
    history.checkpoint(project);
    project.heights[0] = 4;
    const stats = history.stats;
    const cancelled = history.prepareUndo()!;
    cancelled.project.heights[1] = 9;
    cancelled.dispose();
    expect(() => cancelled.commit(project)).toThrow('unavailable');
    expect(history.stats).toEqual(stats);
    const prepared = history.prepareUndo()!;
    const candidate = prepared.project;
    expect(candidate.heights[1]).toBe(project.heights[1]);
    expect(history.stats).toEqual(stats);
    expect(prepared.commit(project)).toBe(candidate);
    expect(() => prepared.commit(project)).toThrow('unavailable');
    expect(history.redoTarget!.heights[0]).toBe(4);
    const redo = history.prepareRedo()!;
    expect(redo.commit(candidate).heights[0]).toBe(4);
  });

  it('rejects stale preparations after branching, clearing, or another restore', () => {
    const project = createProject(16, 32),
      history = new History();
    for (const change of [
      () => history.checkpoint(project),
      () => history.clear(),
      () => history.undo(project),
    ]) {
      history.checkpoint(project);
      const prepared = history.prepareUndo()!;
      change();
      const stats = history.stats;
      expect(() => prepared.commit(project)).toThrow('changed');
      expect(history.stats).toEqual(stats);
      prepared.dispose();
    }
  });

  it('preserves added/deleted scalar keys and special property names without changing prototypes', () => {
    const store = new SnapshotStore();
    const source = Object.assign(Object.create(null), { a: 1, b: undefined });
    Object.defineProperty(source, '__proto__', {
      value: { safe: true },
      enumerable: true,
      writable: true,
    });
    const first = store.capture(source);
    store.retain(first);
    delete source.b;
    source.c = 2;
    const second = store.capture(source, first);
    store.retain(second);
    const restored = store.restore<typeof source>(second);
    expect(Object.getPrototypeOf(restored)).toBe(null);
    expect(Object.hasOwn(restored, 'b')).toBe(false);
    expect(restored.c).toBe(2);
    expect(restored.__proto__).toEqual({ safe: true });
    expect(store.restore<typeof source>(first).b).toBe(undefined);
    expect(Object.hasOwn(store.restore<typeof source>(first), 'b')).toBe(true);
    const flat = { a: 1, b: 2 } as Record<string, number>;
    const flatFirst = store.capture(flat);
    store.retain(flatFirst);
    delete flat.b;
    flat.c = 3;
    const flatSecond = store.capture(flat, flatFirst);
    store.retain(flatSecond);
    expect(store.restore(flatSecond)).toEqual({ a: 1, c: 3 });
    const inspection = store.restore<Record<string, number>>(flatFirst);
    inspection.a = 99;
    expect(store.restore(flatFirst)).toEqual({ a: 1, b: 2 });
    for (const snapshot of [first, second, flatFirst, flatSecond])
      store.release(snapshot);
    expect(store.bytes).toBe(0);
  });

  it('preserves history after a capture failure, including a failed prepared commit', () => {
    const project = createProject(16, 32),
      history = new History();
    history.checkpoint(project);
    const stats = history.stats,
      prepared = history.prepareUndo()!;
    const invalid = { ...project, extra: new Date() };
    expect(() => history.checkpoint(invalid)).toThrow('Unsupported');
    expect(() => prepared.commit(invalid)).toThrow('Unsupported');
    expect(history.stats).toEqual(stats);
    expect(prepared.commit(project)).toEqual(project);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() =>
      history.checkpoint({ ...project, assets: cycle } as TerrainProject),
    ).toThrow('cycles');
    history.clear();
    expect(history.stats.retainedBytes).toBe(0);
  });
});
