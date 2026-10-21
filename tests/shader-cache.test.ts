import { expect, it } from 'vitest';
import { RetainedShaderCache } from '../src/render/shader-cache';

const state = (usedTimes = 0, length = 4) => ({
  usedTimes,
  vertexShader: 'v'.repeat(length),
  fragmentShader: 'f'.repeat(length),
});
it('reuses unused programs, evicts the least recently retired and never evicts active programs', () => {
  const cache = new RetainedShaderCache(2, 1000);
  for (const key of [0, 1, 2, 3]) cache.allow(key);
  const active = state(3),
    first = state(),
    second = state(),
    third = state();
  cache.allow(0);
  cache.set(0, active);
  cache.set(1, first);
  cache.set(2, second);
  cache.delete(1);
  cache.delete(2);
  expect(cache.get(1)).toBe(first);
  first.usedTimes++;
  first.usedTimes--;
  cache.delete(1);
  cache.set(3, third);
  cache.delete(3);
  expect(cache.has(2)).toBe(false);
  expect(cache.has(1)).toBe(true);
  expect(cache.get(0)).toBe(active);
  expect(cache.stats.hits).toBe(1);
  expect(cache.stats.retainedPrograms).toBe(2);
  cache.clear();
  expect(cache.stats.retainedSourceBytes).toBe(0);
  expect(cache.size).toBe(0);
});
it('bounds retained source bytes and supports disabling retention', () => {
  const cache = new RetainedShaderCache(20, 32);
  for (const key of [1, 2, 3]) cache.allow(key);
  cache.set(1, state(0, 4));
  cache.delete(1);
  cache.set(2, state(0, 5));
  cache.delete(2);
  expect(cache.has(1)).toBe(false);
  expect(cache.stats.retainedSourceBytes).toBe(20);
  cache.set(3, state(0, 30));
  cache.delete(3);
  expect(cache.stats.retainedSourceBytes).toBe(0);
  const disabled = new RetainedShaderCache(0, 0);
  disabled.set(1, state());
  disabled.delete(1);
  expect(disabled.size).toBe(0);
});

it('does not retain arbitrary temporary bake programs', () => {
  const cache = new RetainedShaderCache();
  cache.set(1, state());
  cache.delete(1);
  expect(cache.size).toBe(0);
});
