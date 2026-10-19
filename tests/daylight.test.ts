import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  defaultTimeOfDay,
  solarPosition,
  daylightState,
  parseTimeOfDay,
  formatSolarTime,
} from '../src/core/daylight';
import {
  environmentPreset,
  parseEnvironmentSettings,
} from '../src/core/environment';
import { createProject } from '../src/core/terrain';
import { serializeProject, parseProject } from '../src/core/serialization';
import {
  serializeProjectPackage,
  parseProjectPackage,
} from '../src/core/project-package';
import { TerrainEnvironment } from '../src/runtime/environment';

describe('solar time and dynamic lighting', () => {
  it('moves east to west with latitude, season and a rotatable north', () => {
    const equinox = { ...defaultTimeOfDay(), dayOfYear: 80, latitude: 0 };
    expect(solarPosition(equinox, 6).x).toBeCloseTo(1, 4);
    expect(solarPosition(equinox, 18).x).toBeCloseTo(-1, 4);
    expect(solarPosition(equinox, 12).elevation).toBeGreaterThan(89);
    expect(solarPosition({ ...equinox, northOffset: 90 }, 6).z).toBeCloseTo(
      -1,
      4,
    );
    expect(
      solarPosition({ ...equinox, latitude: 60, dayOfYear: 172 }, 12).elevation,
    ).toBeCloseTo(53.45, 0);
    expect(
      solarPosition({ ...equinox, latitude: 60, dayOfYear: 355 }, 12).elevation,
    ).toBeCloseTo(6.58, 0);
    expect(solarPosition(equinox, 0)).toEqual(solarPosition(equinox, 24));
    expect(formatSolarTime(24)).toBe('00:00');
    expect(formatSolarTime(6.5)).toBe('06:30');
  });
  it('handles polar day/night and finite warm sunset response without underground sunlight', () => {
    for (const latitude of [-90, 0, 90])
      for (const dayOfYear of [1, 80, 172, 355])
        for (const hour of [0, 6, 12, 18, 23.99]) {
          const state = daylightState(
            { ...defaultTimeOfDay(), latitude, dayOfYear },
            hour,
          );
          expect(Math.hypot(state.x, state.y, state.z)).toBeCloseTo(1);
          expect(
            Number.isFinite(state.azimuth) && Number.isFinite(state.elevation),
          ).toBe(true);
          expect(state.direct).toBeGreaterThanOrEqual(0);
          if (state.elevation < -0.8) expect(state.direct).toBe(0);
        }
    expect(
      solarPosition({ ...defaultTimeOfDay(), latitude: 90, dayOfYear: 172 }, 0)
        .elevation,
    ).toBeGreaterThan(23);
    expect(
      solarPosition({ ...defaultTimeOfDay(), latitude: 90, dayOfYear: 355 }, 12)
        .elevation,
    ).toBeLessThan(-23);
    const state = daylightState(
      { ...defaultTimeOfDay(), latitude: 0, dayOfYear: 80 },
      17.5,
    );
    expect(state.sunColor[0]).toBeGreaterThan(state.sunColor[2]);
  });
  it('validates new fields, keeps legacy settings unchanged and round-trips native documents', async () => {
    const settings = {
      ...environmentPreset('daylight'),
      timeOfDay: {
        ...defaultTimeOfDay(),
        enabled: true,
        playing: true,
        hour: 6.5,
      },
    };
    const project = createProject(8, 32);
    project.environment = settings;
    expect(parseProject(serializeProject(project))).toEqual(project);
    expect(
      parseProjectPackage(await serializeProjectPackage(project).arrayBuffer()),
    ).toEqual(project);
    expect(
      parseEnvironmentSettings(environmentPreset('golden')).timeOfDay,
    ).toBeUndefined();
    for (const patch of [
      { hour: NaN },
      { hour: 25 },
      { latitude: 91 },
      { dayOfYear: 1.5 },
      { dayLengthMinutes: 0 },
      { haze: 50 },
      { rayleigh: 0 },
      { playing: 1 },
      { autoFog: 'true' },
    ])
      expect(() =>
        parseTimeOfDay({ ...settings.timeOfDay, ...patch }),
      ).toThrow();
    expect(() =>
      parseEnvironmentSettings({ ...settings, mode: 'none' }),
    ).toThrow(/procedural sky/);
  });
  it('advances independently of frame rate, leaves authored data unchanged and stops sunlight at night', () => {
    const project = createProject(8, 32);
    const settings = {
      ...environmentPreset('daylight'),
      timeOfDay: {
        ...defaultTimeOfDay(),
        enabled: true,
        playing: true,
        latitude: 0,
        dayOfYear: 80,
        hour: 12,
        dayLengthMinutes: 1,
      },
    };
    const original = JSON.stringify(settings);
    const a = new TerrainEnvironment(new THREE.Scene()),
      b = new TerrainEnvironment(new THREE.Scene());
    a.set(settings, project);
    b.set(settings, project);
    const sky = a.scene.getObjectByName('Dynamic atmospheric sky')!;
    a.tick(30);
    for (let i = 0; i < 1800; i++) b.tick(1 / 60);
    expect(a.solarHour).toBeCloseTo(b.solarHour, 8);
    expect(a.sun.intensity).toBe(0);
    expect(a.sun.castShadow).toBe(false);
    expect(a.scene.getObjectByName('Dynamic atmospheric sky')).toBe(sky);
    expect(JSON.stringify(settings)).toBe(original);
    a.tick(NaN);
    a.tick(-1);
    expect(a.solarHour).toBe(0);
    a.set(
      {
        ...settings,
        timeOfDay: { ...settings.timeOfDay, playing: false, hour: 14 },
      },
      project,
    );
    a.tick(500);
    expect(a.solarHour).toBe(14);
    expect(a.sun.castShadow).toBe(true);
    a.dispose();
    b.dispose();
  });
  it('controls visible sky brightness independently of filtered illumination', () => {
    const scene = new THREE.Scene();
    const lighting = new TerrainEnvironment(scene);
    const project = createProject(8, 32);
    const settings = environmentPreset('natural');
    lighting.set(settings, project);
    const sky = scene.getObjectByName('Dynamic atmospheric sky') as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.ShaderMaterial
    >;
    expect(sky.material.uniforms.terrainIntensity.value).toBe(1);
    expect(scene.environmentIntensity).toBe(0.2);
    lighting.set(
      { ...settings, backgroundIntensity: 0.5, environmentIntensity: 0.3 },
      project,
    );
    expect(scene.getObjectByName('Dynamic atmospheric sky')).toBe(sky);
    expect(sky.material.uniforms.terrainIntensity.value).toBe(0.5);
    expect(scene.environmentIntensity).toBe(0.3);
    lighting.dispose();
  });
  it('reuses fitted terrain bounds while playing and restores ownership when leaving the dynamic sky', async () => {
    const project = createProject(16, 64),
      scene = new THREE.Scene();
    const originalBackground = new THREE.Color('#345678');
    scene.background = originalBackground;
    const lighting = new TerrainEnvironment(scene);
    const settings = {
      ...environmentPreset('daylight'),
      timeOfDay: { ...defaultTimeOfDay(), enabled: true, playing: true },
    };
    const candidate = await lighting.prepare(settings);
    lighting.apply(candidate, project);
    const iterator = project.heights[Symbol.iterator];
    project.heights[Symbol.iterator] = () => {
      throw new Error('Unexpected height scan');
    };
    expect(() => lighting.tick(1)).not.toThrow();
    project.heights[Symbol.iterator] = iterator;
    const current = scene.getObjectByName('Dynamic atmospheric sky');
    const rejected = await lighting.prepare({
      ...settings,
      timeOfDay: { ...settings.timeOfDay, hour: 0 },
    });
    rejected.dispose();
    expect(scene.getObjectByName('Dynamic atmospheric sky')).toBe(current);
    lighting.set(environmentPreset('golden'), project);
    expect(scene.getObjectByName('Dynamic atmospheric sky')).toBeUndefined();
    expect(candidate.disposed).toBe(true);
    lighting.dispose();
    expect(scene.background).toBe(originalBackground);
    expect(scene.children).toHaveLength(0);
  });
});
