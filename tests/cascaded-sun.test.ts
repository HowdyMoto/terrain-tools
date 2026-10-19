import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createProject } from '../src/core/terrain';
import {
  defaultEnvironmentSettings,
  parseEnvironmentSettings,
} from '../src/core/environment';
import {
  TerrainEnvironment,
  prepareEnvironment,
} from '../src/runtime/environment';
import { CascadedSun } from '../src/runtime/cascaded-sun';
import {
  bindMaterialEffect,
  materialEffectUniforms,
} from '../src/runtime/material-effects';
import { configureFoliageFade } from '../src/runtime/foliage-fade';
import { serializeProject, parseProject } from '../src/core/serialization';

const settings = () => ({
  ...defaultEnvironmentSettings(),
  shadowCascades: 3 as const,
  shadowDistance: 120,
});

describe('camera-following sun shadows', () => {
  it('preserves legacy defaults and rejects invalid cascade settings', () => {
    expect(
      parseEnvironmentSettings(defaultEnvironmentSettings()).shadowCascades,
    ).toBeUndefined();
    expect(parseEnvironmentSettings(settings()).shadowDistance).toBe(120);
    for (const patch of [
      { shadowCascades: 2 },
      { shadowCascades: '3' },
      { shadowDistance: 0 },
      { shadowDistance: Infinity },
      { shadowDistance: 2001 },
      { temporalAA: 'yes' },
      { temporalSharpness: -0.1 },
      { temporalSharpness: 1.1 },
      { temporalSharpness: NaN },
      { temporalSharpness: '0.5' },
      { ambientOcclusion: { enabled: true, radius: 0, strength: 1 } },
      { ambientOcclusion: { enabled: true, radius: 2, strength: NaN } },
    ])
      expect(() =>
        parseEnvironmentSettings({ ...settings(), ...patch }),
      ).toThrow();
  });
  it('round-trips the complete forest quality settings without changing legacy files', () => {
    const project = createProject(8, 32);
    project.environment = {
      ...settings(),
      temporalAA: true,
      temporalSharpness: 0.5,
      ambientOcclusion: { enabled: true, radius: 3, strength: 1.25 },
    };
    expect(parseProject(serializeProject(project))).toEqual(project);
    const legacy = parseEnvironmentSettings(defaultEnvironmentSettings());
    expect(legacy.temporalAA).toBeUndefined();
    expect(legacy.temporalSharpness).toBeUndefined();
    expect(legacy.ambientOcclusion).toBeUndefined();
  });
  it('fits overlapping view slices, preserves solar energy and restores local hooks on disposal', async () => {
    const scene = new THREE.Scene();
    const project = createProject(8, 256);
    const material = new THREE.MeshStandardMaterial();
    let fading = false;
    configureFoliageFade(material, () => fading);
    const original = material.onBeforeCompile;
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const environment = new TerrainEnvironment(scene);
    const prepared = await prepareEnvironment(settings());
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
    camera.position.set(0, 3, 6);
    camera.lookAt(0, 3, -30);
    environment.apply(prepared, project);
    environment.updateCamera(camera);
    const cascades = prepared.cascades!;
    expect(environment.sun.visible).toBe(false);
    expect(cascades.lights).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const light = cascades.lights[i];
      expect(light.intensity).toBe(environment.sun.intensity);
      light.shadow.updateMatrices(light);
      const depths = [
        i === 0 ? 0.1 : cascades.splits.getComponent(i - 1) * 0.95,
        cascades.splits.getComponent(i) * (i === 2 ? 1 : 1.05),
      ];
      for (const depth of depths)
        for (const x of [-1, 1])
          for (const y of [-1, 1]) {
            const point = new THREE.Vector3(x, y, -1).applyMatrix4(
              camera.projectionMatrixInverse,
            );
            point
              .multiplyScalar(depth / -point.z)
              .applyMatrix4(camera.matrixWorld)
              .project(light.shadow.camera);
            expect(
              Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)),
            ).toBeLessThanOrEqual(1.001);
          }
    }
    const staticKey = material.customProgramCacheKey();
    fading = true;
    expect(material.customProgramCacheKey()).not.toBe(staticKey);
    expect(THREE.ShaderChunk.lights_fragment_begin).toBe(chunk);
    environment.dispose();
    expect(material.onBeforeCompile).toBe(original);
    expect(cascades.group.parent).toBeNull();
    material.dispose();
  });
  it('releases partially allocated candidates and retains a working rig after failure and retry', async () => {
    const scene = new THREE.Scene();
    const environment = new TerrainEnvironment(scene);
    const project = createProject(8, 32);
    environment.set(defaultEnvironmentSettings(), project);
    const previous = scene.environment;
    const dispose = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');
    let allocations = 0;
    const renderer = {
      initRenderTarget() {
        if (++allocations === 2) throw new Error('injected shadow allocation');
      },
    } as unknown as THREE.WebGLRenderer;
    expect(() => new CascadedSun(settings(), renderer)).toThrow('injected');
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(scene.environment).toBe(previous);
    const prepared = await environment.prepare(settings());
    environment.apply(prepared, project);
    environment.updateCamera(new THREE.PerspectiveCamera());
    expect(environment.sun.visible).toBe(false);
    environment.dispose();
    dispose.mockRestore();
  });
  it('removes stacked scene effects in either order and keeps asset shader hooks', () => {
    const material = new THREE.MeshStandardMaterial();
    const original = material.onBeforeCompile;
    const a = {},
      b = {};
    const calls: string[] = [];
    const first = bindMaterialEffect(material, a, {
      key: 'first',
      compile: () => calls.push('first'),
      disposed: () => {},
    });
    const second = bindMaterialEffect(material, b, {
      key: 'second',
      compile: () => calls.push('second'),
      disposed: () => {},
    });
    first();
    material.onBeforeCompile(
      {} as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(calls).toEqual(['second']);
    second();
    expect(material.onBeforeCompile).toBe(original);
  });
  it('keeps cached shader uniforms connected to replacement lighting rigs', () => {
    const material = new THREE.MeshStandardMaterial();
    const previous = {
      strength: { value: 1 },
      splits: { value: new THREE.Vector3(1, 2, 3) },
    };
    const cached = materialEffectUniforms(material, previous);
    const next = {
      strength: { value: 2 },
      splits: { value: new THREE.Vector3(4, 5, 6) },
    };
    const rebound = materialEffectUniforms(material, next);
    expect(rebound.strength).toBe(cached.strength);
    expect(cached.strength.value).toBe(2);
    expect(cached.splits.value).toBe(next.splits.value);
    next.strength.value = 0;
    expect(cached.strength.value).toBe(0);
    const other = materialEffectUniforms(
      new THREE.MeshStandardMaterial(),
      previous,
    );
    expect(other.strength.value).toBe(1);
    material.dispose();
  });
});
