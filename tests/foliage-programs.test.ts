import { expect, it } from 'vitest';
import * as THREE from 'three';
import { configureWind, windUniforms } from '../src/runtime/wind';
import { configureFoliageFade } from '../src/runtime/foliage-fade';
import { configureFoliageSubsurface } from '../src/runtime/foliage-shading';
import { defaultFoliageSubsurface } from '../src/core/foliage-shading';

it('shares equal foliage graphs across independently timed tiles without sharing wind values', () => {
  const a = new THREE.MeshStandardMaterial(),
    b = new THREE.MeshStandardMaterial();
  a.alphaTest = b.alphaTest = 0.5;
  const first = windUniforms(),
    second = windUniforms();
  first.uTime.value = 12;
  second.uTime.value = 100;
  for (const [material, values] of [
    [a, first],
    [b, second],
  ] as const) {
    configureWind(material, 0.7, values, 0);
    configureFoliageFade(material);
    configureFoliageSubsurface(material, defaultFoliageSubsurface());
  }
  expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
  expect(
    (a as unknown as { terrainWindUniforms: object }).terrainWindUniforms,
  ).toBe(first);
  expect(
    (b as unknown as { terrainWindUniforms: object }).terrainWindUniforms,
  ).toBe(second);
  const different = new THREE.MeshStandardMaterial();
  configureWind(different, 0.8, second, 0);
  expect(different.customProgramCacheKey()).not.toBe(a.customProgramCacheKey());
});
