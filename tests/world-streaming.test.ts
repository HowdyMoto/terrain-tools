import { describe, expect, it, vi } from 'vitest';
import {
  validateTerrainWorld,
  WorldTileIndex,
  worldTileKey,
} from '../src/core/world';
import type { TerrainWorld } from '../src/core/world';
import { WorldStreamer } from '../src/core/world-streamer';
import type { WorldTileResource } from '../src/core/world-streamer';

function world(count = 5): TerrainWorld {
  return {
    kind: 'terrain-world',
    version: 1,
    tileSize: 100,
    tiles: Array.from({ length: count }, (_, x) => ({
      x,
      z: 0,
      source: `tile-${x}`,
    })),
  };
}
function resource(value: string, cpuBytes = 10, gpuBytes = 20) {
  return { value, cpuBytes, gpuBytes, dispose: vi.fn() };
}
function controlled() {
  const calls: {
    key: string;
    signal: AbortSignal;
    resolve: (value: WorldTileResource<string>) => void;
    reject: (reason: Error) => void;
  }[] = [];
  const source = {
    load: vi.fn(
      (tile, signal: AbortSignal) =>
        new Promise<WorldTileResource<string>>((resolve, reject) => {
          calls.push({
            key: worldTileKey(tile.x, tile.z),
            signal,
            resolve,
            reject,
          });
        }),
    ),
  };
  return { source, calls };
}
// Flush only deterministic promise work; no timers or network dependencies.
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('world metadata and spatial selection', () => {
  it('copies immutable metadata and rejects unsupported or ambiguous manifests', () => {
    const input = world();
    const validated = validateTerrainWorld(input);
    expect(validated).toEqual(input);
    expect(validated.tiles).not.toBe(input.tiles);
    expect(Object.isFrozen(validated.tiles[0])).toBe(true);
    for (const invalid of [
      null,
      { ...input, version: 2 },
      { ...input, tileSize: Infinity },
      { ...input, tiles: [input.tiles[0], input.tiles[0]] },
      { ...input, tiles: [{ x: 0.5, z: 0, source: 'a' }] },
      { ...input, tiles: [{ x: 0, z: 0, source: ' ' }] },
    ])
      expect(() => validateTerrainWorld(invalid)).toThrow();
  });

  it('selects negative coordinates, half-open cells and symmetric circle tangencies', () => {
    const index = new WorldTileIndex({
      ...world(),
      tiles: [-2, -1, 0, 1, 2].map((x) => ({ x, z: 0, source: `${x}` })),
    });
    expect(index.select({ x: -0.1, z: 50 }, 0).map((t) => t.key)).toEqual([
      '-1,0',
    ]);
    expect(index.select({ x: 0, z: 50 }, 0).map((t) => t.key)).toEqual(['0,0']);
    expect(index.select({ x: 50, z: 50 }, 50).map((t) => t.key)).toEqual([
      '0,0',
      '-1,0',
      '1,0',
    ]);
    expect(index.select({ x: 150, z: 50 }, 250, 2).map((t) => t.key)).toEqual([
      '1,0',
      '0,0',
    ]);
    expect(() => index.select({ x: NaN, z: 0 }, 10)).toThrow();
    expect(() => index.select({ x: 0, z: 0 }, 1e9)).toThrow(/bounded/);
  });
});

describe('bounded asynchronous world residency', () => {
  it('starts nearest-first, bounds load and resident counts, and releases evicted resources', async () => {
    const { source, calls } = controlled();
    const stream = new WorldStreamer(world(), source, {
      radius: 200,
      maxResidentTiles: 3,
      maxConcurrentLoads: 2,
    });
    stream.update({ x: 150, z: 50 });
    await settle();
    expect(calls.map((c) => c.key)).toEqual(['1,0', '0,0']);
    expect(stream.stats).toMatchObject({ loadingTiles: 2, queuedTiles: 1 });
    const a = resource('one'),
      b = resource('zero'),
      c = resource('two');
    calls[0].resolve(a);
    await settle();
    expect(calls.map((c) => c.key)).toEqual(['1,0', '0,0', '2,0']);
    calls[1].resolve(b);
    calls[2].resolve(c);
    await stream.whenIdle();
    expect(stream.stats).toMatchObject({
      residentTiles: 3,
      cpuBytes: 30,
      gpuBytes: 60,
    });
    expect(stream.get('1,0')).toBe('one');
    // A host retaining its handle cannot corrupt the streamer's admitted accounting.
    a.cpuBytes = 9999;
    stream.update({ x: 10000, z: 0 });
    expect(stream.stats).toMatchObject({
      residentTiles: 0,
      cpuBytes: 0,
      gpuBytes: 0,
    });
    for (const r of [a, b, c]) expect(r.dispose).toHaveBeenCalledTimes(1);
    stream.dispose();
  });

  it('keeps cancelled loads in their slots, disposes stale results and reloads a revisited cell', async () => {
    const { source, calls } = controlled();
    const stream = new WorldStreamer(world(), source, {
      radius: 0,
      maxConcurrentLoads: 1,
    });
    stream.update({ x: 50, z: 50 });
    await settle();
    stream.update({ x: 450, z: 50 });
    expect(calls[0].signal.aborted).toBe(true);
    await settle();
    expect(calls).toHaveLength(1);
    // Return before the old source, which ignores cancellation, has settled.
    stream.update({ x: 50, z: 50 });
    const stale = resource('stale');
    calls[0].resolve(stale);
    await settle();
    expect(stale.dispose).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    const current = resource('current');
    calls[1].resolve(current);
    await stream.whenIdle();
    expect(stream.get('0,0')).toBe('current');
    stream.dispose();
    stream.dispose();
    expect(current.dispose).toHaveBeenCalledTimes(1);
  });

  it('records errors without automatic retry and supports a successful explicit retry', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(resource('ready'));
    const stream = new WorldStreamer(world(), { load }, { radius: 0 });
    stream.update({ x: 50, z: 50 });
    await stream.whenIdle();
    expect(stream.errors.get('0,0')?.message).toBe('offline');
    stream.update({ x: 50, z: 50 });
    await stream.whenIdle();
    expect(load).toHaveBeenCalledTimes(1);
    stream.retry('0,0');
    await stream.whenIdle();
    expect(stream.get('0,0')).toBe('ready');
    expect(stream.stats.failedTiles).toBe(0);
    stream.dispose();
  });

  it.each(['cpu', 'gpu', 'invalid'] as const)(
    'rejects and releases %s budget violations without evicting admitted cells',
    async (kind) => {
      const a = resource('first', 10, 20);
      const b = resource(
        'second',
        kind === 'invalid' ? NaN : kind === 'cpu' ? 100 : 10,
        kind === 'gpu' ? 100 : 20,
      );
      const load = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
      const stream = new WorldStreamer(
        world(2),
        { load },
        {
          radius: 100,
          maxConcurrentLoads: 1,
          cpuByteLimit: 20,
          gpuByteLimit: 40,
        },
      );
      stream.update({ x: 50, z: 50 });
      await stream.whenIdle();
      expect(stream.residentKeys).toEqual(['0,0']);
      expect(stream.stats).toMatchObject({
        cpuBytes: 10,
        gpuBytes: 20,
        failedTiles: 1,
      });
      expect(b.dispose).toHaveBeenCalledTimes(1);
      expect(a.dispose).not.toHaveBeenCalled();
      stream.dispose();
    },
  );

  it('cancels queued work before source invocation and drains late results after disposal', async () => {
    const { source, calls } = controlled();
    const stream = new WorldStreamer(world(), source, { radius: 0 });
    stream.update({ x: 50, z: 50 });
    stream.update({ x: 450, z: 50 });
    await settle();
    expect(calls.map((c) => c.key)).toEqual(['4,0']);
    let idle = false;
    const pending = stream.whenIdle().then(() => {
      idle = true;
    });
    stream.dispose();
    await settle();
    expect(calls[0].signal.aborted).toBe(true);
    expect(idle).toBe(false);
    const late = resource('late');
    calls[0].resolve(late);
    await pending;
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(stream.stats).toMatchObject({
      residentTiles: 0,
      loadingTiles: 0,
      cpuBytes: 0,
    });
    expect(() => stream.update({ x: 0, z: 0 })).toThrow(/disposed/);
    expect(() => stream.retry()).toThrow(/disposed/);
  });

  it('handles synchronous source failures without recursive scheduling or unhandled rejection', async () => {
    const load = vi.fn(() => {
      throw new Error('sync failure');
    });
    const dense: TerrainWorld = {
      ...world(),
      tileSize: 1,
      tiles: Array.from({ length: 4096 }, (_, i) => ({
        x: i % 64,
        z: Math.floor(i / 64),
        source: `${i}`,
      })),
    };
    const stream = new WorldStreamer(
      dense,
      { load },
      { radius: 50, maxResidentTiles: 4096, maxConcurrentLoads: 1 },
    );
    stream.update({ x: 32, z: 32 });
    await stream.whenIdle();
    expect(load).toHaveBeenCalledTimes(4096);
    expect(stream.stats.failedTiles).toBe(4096);
    stream.dispose();
  });
});
