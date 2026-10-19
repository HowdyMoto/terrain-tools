import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AssetRegistry } from '../src/core/asset-registry';
import { WorldAssets } from '../src/runtime/world-assets';
import { ModelLibrary } from '../src/render/models';
import { TerrainScene } from '../src/runtime/terrain-scene';
import { createProject } from '../src/core/terrain';
const bytes = { encodedBytes: 10, cpuBytes: 20, gpuBytes: 30 };
const budget = { cpuBytes: 60, gpuBytes: 60, stagingBytes: 100 };
function resource(value: string) {
  return { value, ...bytes, dispose: vi.fn() };
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}

describe('shared world asset leases', () => {
  it('bounds zero-byte entries and evicts only released metadata', async () => {
    const registry = new AssetRegistry<string>({ ...budget, maxEntries: 2 });
    const empty = { encodedBytes: 0, cpuBytes: 0, gpuBytes: 0 };
    const a = { ...resource('a'), ...empty },
      b = { ...resource('b'), ...empty };
    const first = await registry.acquire('a', empty, 0, async () => a);
    const second = await registry.acquire('b', empty, 0, async () => b);
    await expect(
      registry.acquire('c', empty, 0, async () => a),
    ).rejects.toThrow(/budget/);
    second.release();
    const third = await registry.acquire('c', empty, 0, async () => ({
      ...resource('c'),
      ...empty,
    }));
    expect(a.dispose).not.toHaveBeenCalled();
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(registry.stats.active).toBe(2);
    first.release();
    third.release();
    registry.dispose();
  });
  it('deduplicates concurrent loading and cancellation does not invalidate another waiter', async () => {
    const registry = new AssetRegistry<string>(budget),
      wait = pending<ReturnType<typeof resource>>();
    const load = vi.fn(() => wait.promise),
      cancel = new AbortController();
    const a = registry.acquire('same', bytes, 10, load, cancel.signal);
    const b = registry.acquire('same', bytes, 10, load);
    const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    cancel.abort();
    const r = resource('shared');
    wait.resolve(r);
    await rejected;
    const lease = await b;
    expect(load).toHaveBeenCalledTimes(1);
    expect(lease.value).toBe('shared');
    registry.dispose();
    expect(r.dispose).not.toHaveBeenCalled();
    lease.release();
    lease.release();
    expect(r.dispose).toHaveBeenCalledTimes(1);
    expect(registry.stats.cpuBytes).toBe(0);
  });
  it('evicts unleased assets while preserving active resources and rejects excessive staging', async () => {
    const registry = new AssetRegistry<string>(budget),
      a = resource('a'),
      b = resource('b'),
      c = resource('c');
    const first = await registry.acquire('a', bytes, 0, async () => a);
    const second = await registry.acquire('b', bytes, 0, async () => b);
    await expect(
      registry.acquire('c', bytes, 0, async () => c),
    ).rejects.toThrow(/budget/);
    expect(a.dispose).not.toHaveBeenCalled();
    first.release();
    const third = await registry.acquire('c', bytes, 0, async () => c);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();
    second.release();
    third.release();
    registry.trim();
    await expect(
      registry.acquire('big', bytes, 100, async () => c),
    ).rejects.toThrow(/staging/);
    expect(registry.stats).toMatchObject({
      cpuBytes: 0,
      gpuBytes: 0,
      cached: 0,
    });
    expect(registry.stats.peak.cpuBytes).toBe(60);
    registry.dispose();
  });
  it('releases late cancelled results and failed reservations and permits a retry', async () => {
    const registry = new AssetRegistry<string>(budget),
      wait = pending<ReturnType<typeof resource>>();
    const cancel = new AbortController();
    const request = registry.acquire(
      'a',
      bytes,
      0,
      () => wait.promise,
      cancel.signal,
    );
    await Promise.resolve();
    const rejected = expect(request).rejects.toMatchObject({
      name: 'AbortError',
    });
    cancel.abort();
    const r = resource('late');
    wait.resolve(r);
    await rejected;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(r.dispose).toHaveBeenCalledTimes(1);
    const oversized = { ...resource('too big'), cpuBytes: 100 };
    await expect(
      registry.acquire('a', bytes, 0, async () => oversized),
    ).rejects.toThrow(/reservation/);
    expect(oversized.dispose).toHaveBeenCalledTimes(1);
    const retry = await registry.acquire('a', bytes, 0, async () =>
      resource('ok'),
    );
    expect(retry.value).toBe('ok');
    retry.release();
    registry.dispose();
  });
  it('shares transformed foliage buffers across tiles and preserves a surviving tile on eviction', async () => {
    const geometry = new THREE.PlaneGeometry(),
      material = new THREE.MeshStandardMaterial();
    const cache = new WorldAssets(undefined, async () => ({
      parts: [{ geometry, material, matrix: new THREE.Matrix4() }],
      dispose: () => {
        geometry.dispose();
        material.dispose();
      },
    }));
    const p = createProject(8, 32);
    p.view.water = false;
    p.assets = { plant: { name: 'Plant', data: 'shared' } };
    p.brushes[0].model = 'plant';
    p.foliage = [{ id: 1, brushId: 'pine', x: 0, z: 0, scale: 1, rotation: 0 }];
    const a = new TerrainScene(p, { assets: cache }),
      b = new TerrainScene(structuredClone(p), { assets: cache });
    await a.load(p, false);
    await b.load(b.project, false);
    const ga = (a.foliage.children[0] as THREE.Mesh).geometry,
      gb = (b.foliage.children[0] as THREE.Mesh).geometry;
    expect(ga).toBe(gb);
    const freed = vi.fn();
    gb.addEventListener('dispose', freed);
    a.dispose();
    expect(freed).not.toHaveBeenCalled();
    expect(gb.getAttribute('position').count).toBe(4);
    b.dispose();
    expect(freed).toHaveBeenCalledTimes(1);
    cache.dispose();
  });
  it('shares decoded plant geometry and textures between independent model libraries', async () => {
    const geometry = new THREE.BoxGeometry();
    const texture = new THREE.DataTexture(new Uint8Array(64), 4, 4);
    const material = new THREE.MeshStandardMaterial({ map: texture });
    const decoded = {
      parts: [{ geometry, material, matrix: new THREE.Matrix4() }],
      dispose: vi.fn(() => {
        geometry.dispose();
        material.dispose();
        texture.dispose();
      }),
    };
    const decode = vi.fn(async () => decoded);
    const cache = new WorldAssets(undefined, decode);
    const a = new ModelLibrary(cache.decode),
      b = new ModelLibrary(cache.decode);
    const p = {
      assets: { plant: { name: 'Plant', data: 'identical payload' } },
    };
    await Promise.all([a.loadAssets(p), b.loadAssets(p)]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(a.get('plant')[0].geometry).toBe(b.get('plant')[0].geometry);
    expect(a.get('plant')[0].material).toBe(b.get('plant')[0].material);
    a.dispose();
    cache.trim();
    expect(decoded.dispose).not.toHaveBeenCalled();
    expect(b.get('plant')).toBe(decoded.parts);
    b.dispose();
    cache.trim();
    expect(decoded.dispose).toHaveBeenCalledTimes(1);
    expect(cache.stats.active).toBe(0);
    cache.dispose();
  });
});
