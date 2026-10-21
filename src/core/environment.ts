import { defaultTimeOfDay, parseTimeOfDay } from './daylight';
import type { TimeOfDaySettings } from './daylight';

export interface EnvironmentSettings {
  /** Optional approximate static canopy visibility and local ground bounce. */
  canopyLighting?: { enabled: boolean; strength: number; bounce: number };
  /** Optional astronomical sun path and atmospheric sky; omitted preserves static lighting. */
  timeOfDay?: TimeOfDaySettings;
  mode: 'none' | 'sky' | 'image';
  skyColor: string;
  horizonColor: string;
  groundColor: string;
  sunColor: string;
  sunIntensity: number;
  sunAzimuth: number;
  sunElevation: number;
  ambientIntensity: number;
  environmentIntensity: number;
  /** Independent visible sky/HDRI brightness. Omitted follows environmentIntensity for legacy files. */
  backgroundIntensity?: number;
  rotation: number;
  showBackground: boolean;
  backgroundColor: string;
  backgroundBlur: number;
  exposure: number;
  toneMapping: 'aces' | 'neutral' | 'agx';
  fogEnabled: boolean;
  fogColor: string;
  fogNear: number;
  fogFar: number;
  shadows: boolean;
  shadowResolution: 1024 | 2048 | 4096;
  /** Camera-following sun cascades. Omitted/1 retains the terrain-wide shadow. */
  shadowCascades?: 1 | 3;
  /** View-space shadow reach in metres; the final cascade fades out at this distance. */
  shadowDistance?: number;
  /** Screen-space occlusion of indirect light; direct sun and leaf transmission remain untouched. */
  ambientOcclusion?: { enabled: boolean; radius: number; strength: number };
  /** Optional temporal stabilization of fine foliage; omitted preserves renderer MSAA. */
  temporalAA?: boolean;
  /** Bounded detail recovery after temporal resolve, 0–1; omitted uses 0.25. */
  temporalSharpness?: number;
  shadowBias: number;
  shadowNormalBias: number;
  shadowPadding: number;
  /** Embedded Radiance HDR or OpenEXR, with a 2:1 equirectangular projection. */
  image?: { name: string; data: string };
}
/** Legacy projects retain the editor's original light rig until a look is chosen. */
export function defaultEnvironmentSettings(): EnvironmentSettings {
  return {
    mode: 'none',
    skyColor: '#dce6e7',
    horizonColor: '#dce3df',
    groundColor: '#515749',
    sunColor: '#fff0d1',
    sunIntensity: 3.2,
    sunAzimuth: 309.5,
    sunElevation: 49.75,
    ambientIntensity: 2,
    environmentIntensity: 1,
    rotation: 0,
    showBackground: true,
    backgroundColor: '#aebbb6',
    backgroundBlur: 0,
    exposure: 1.15,
    toneMapping: 'aces',
    fogEnabled: true,
    fogColor: '#aebbb6',
    fogNear: 300,
    fogFar: 850,
    shadows: true,
    shadowResolution: 2048,
    shadowBias: -0.0002,
    shadowNormalBias: 0.18,
    shadowPadding: 24,
  };
}
export type EnvironmentPreset =
  'daylight' | 'golden' | 'overcast' | 'studio' | 'natural';
export function environmentPreset(
  preset: EnvironmentPreset,
): EnvironmentSettings {
  const base = {
    ...defaultEnvironmentSettings(),
    mode: 'sky' as const,
    skyColor: '#80aed2',
    horizonColor: '#dce5e7',
    ambientIntensity: 0.2,
    exposure: 1,
  };
  if (preset === 'natural')
    return {
      ...base,
      timeOfDay: { ...defaultTimeOfDay(), enabled: true, hour: 15 },
      sunColor: '#ffffff',
      sunIntensity: 6,
      ambientIntensity: 0.03,
      environmentIntensity: 0.2,
      backgroundIntensity: 1,
      toneMapping: 'agx',
      shadowResolution: 2048,
      shadowCascades: 3,
      shadowDistance: 160,
      ambientOcclusion: { enabled: true, radius: 2.5, strength: 1.25 },
      temporalAA: true,
      temporalSharpness: 0.25,
      shadowBias: -0.00005,
      shadowNormalBias: 0.025,
      fogNear: 150,
      fogFar: 900,
    };
  if (preset === 'golden')
    return {
      ...base,
      skyColor: '#7d96af',
      horizonColor: '#f0c09d',
      sunColor: '#ffbf79',
      sunAzimuth: 250,
      sunElevation: 16,
      sunIntensity: 3,
      environmentIntensity: 0.75,
      fogColor: '#c5b3a4',
    };
  if (preset === 'overcast')
    return {
      ...base,
      skyColor: '#b5c2cb',
      horizonColor: '#dce0df',
      sunIntensity: 0.35,
      sunColor: '#f4f8ff',
      environmentIntensity: 1.6,
      fogColor: '#b8c3c6',
      fogNear: 120,
      fogFar: 600,
    };
  if (preset === 'studio')
    return {
      ...base,
      skyColor: '#bcbcbc',
      horizonColor: '#dedede',
      groundColor: '#656565',
      sunColor: '#ffffff',
      sunIntensity: 2,
      sunElevation: 60,
      showBackground: false,
      backgroundColor: '#55595b',
      fogEnabled: false,
      toneMapping: 'neutral',
    };
  return base;
}
export function parseEnvironmentSettings(value: unknown): EnvironmentSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid environment settings.');
  const raw = value as Record<string, unknown>,
    result = {} as EnvironmentSettings;
  if (!['none', 'sky', 'image'].includes(raw.mode as string))
    throw new Error('Invalid environment mode.');
  if (!['aces', 'neutral', 'agx'].includes(raw.toneMapping as string))
    throw new Error('Invalid tone mapping.');
  result.mode = raw.mode as EnvironmentSettings['mode'];
  result.toneMapping = raw.toneMapping as EnvironmentSettings['toneMapping'];
  const numbers: Record<string, [number, number]> = {
    sunIntensity: [0, 20],
    sunAzimuth: [0, 360],
    sunElevation: [2, 90],
    ambientIntensity: [0, 10],
    environmentIntensity: [0, 10],
    rotation: [-180, 180],
    backgroundBlur: [0, 1],
    exposure: [0.05, 8],
    fogNear: [0, 100000],
    fogFar: [0.01, 200000],
    shadowBias: [-0.01, 0.01],
    shadowNormalBias: [0, 5],
    shadowPadding: [0, 1000],
  };
  const record = result as unknown as Record<string, unknown>;
  if (raw.canopyLighting !== undefined) {
    const canopy = raw.canopyLighting as Record<string, unknown>;
    if (
      !canopy ||
      typeof canopy.enabled !== 'boolean' ||
      typeof canopy.strength !== 'number' ||
      !Number.isFinite(canopy.strength) ||
      canopy.strength < 0 ||
      canopy.strength > 1 ||
      typeof canopy.bounce !== 'number' ||
      !Number.isFinite(canopy.bounce) ||
      canopy.bounce < 0 ||
      canopy.bounce > 1
    )
      throw new Error('Invalid canopy lighting settings.');
    result.canopyLighting = {
      enabled: canopy.enabled,
      strength: canopy.strength,
      bounce: canopy.bounce,
    };
  }
  if (raw.backgroundIntensity !== undefined) {
    if (
      typeof raw.backgroundIntensity !== 'number' ||
      !Number.isFinite(raw.backgroundIntensity) ||
      raw.backgroundIntensity < 0 ||
      raw.backgroundIntensity > 10
    )
      throw new Error('Invalid environment backgroundIntensity.');
    result.backgroundIntensity = raw.backgroundIntensity;
  }
  for (const [key, [min, max]] of Object.entries(numbers)) {
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
      throw new Error('Invalid environment ' + key + '.');
    record[key] = v;
  }
  if (result.fogFar <= result.fogNear)
    throw new Error('Fog end must be beyond fog start.');
  if (![1024, 2048, 4096].includes(raw.shadowResolution as number))
    throw new Error('Invalid shadow resolution.');
  result.shadowResolution =
    raw.shadowResolution as EnvironmentSettings['shadowResolution'];
  if (raw.shadowCascades !== undefined) {
    if (raw.shadowCascades !== 1 && raw.shadowCascades !== 3)
      throw new Error('Invalid shadow cascade count.');
    result.shadowCascades = raw.shadowCascades;
  }
  if (raw.shadowDistance !== undefined) {
    if (
      typeof raw.shadowDistance !== 'number' ||
      !Number.isFinite(raw.shadowDistance) ||
      raw.shadowDistance < 10 ||
      raw.shadowDistance > 2000
    )
      throw new Error('Shadow distance must be between 10 and 2000 metres.');
    result.shadowDistance = raw.shadowDistance;
  }
  if (raw.ambientOcclusion !== undefined) {
    const ao = raw.ambientOcclusion as Record<string, unknown>;
    if (
      !ao ||
      typeof ao.enabled !== 'boolean' ||
      typeof ao.radius !== 'number' ||
      !Number.isFinite(ao.radius) ||
      ao.radius < 0.1 ||
      ao.radius > 10 ||
      typeof ao.strength !== 'number' ||
      !Number.isFinite(ao.strength) ||
      ao.strength < 0 ||
      ao.strength > 3
    )
      throw new Error('Invalid ambient occlusion settings.');
    result.ambientOcclusion = {
      enabled: ao.enabled,
      radius: ao.radius,
      strength: ao.strength,
    };
  }
  if (raw.temporalAA !== undefined) {
    if (typeof raw.temporalAA !== 'boolean')
      throw new Error('Invalid temporal antialiasing setting.');
    result.temporalAA = raw.temporalAA;
  }
  if (raw.temporalSharpness !== undefined) {
    if (
      typeof raw.temporalSharpness !== 'number' ||
      !Number.isFinite(raw.temporalSharpness) ||
      raw.temporalSharpness < 0 ||
      raw.temporalSharpness > 1
    )
      throw new Error('Temporal detail recovery must be between 0 and 1.');
    result.temporalSharpness = raw.temporalSharpness;
  }
  for (const key of ['showBackground', 'fogEnabled', 'shadows']) {
    if (typeof raw[key] !== 'boolean')
      throw new Error('Invalid environment ' + key + '.');
    record[key] = raw[key];
  }
  for (const key of [
    'skyColor',
    'horizonColor',
    'groundColor',
    'sunColor',
    'backgroundColor',
    'fogColor',
  ]) {
    if (
      typeof raw[key] !== 'string' ||
      !/^#[0-9a-f]{6}$/i.test(raw[key] as string)
    )
      throw new Error('Invalid environment color.');
    record[key] = raw[key];
  }
  if (raw.image !== undefined) {
    const image = raw.image as Record<string, unknown>;
    if (
      !image ||
      typeof image.name !== 'string' ||
      !image.name.trim() ||
      image.name.length > 120 ||
      typeof image.data !== 'string' ||
      image.data.length > 42_666_720 ||
      !/^data:application\/octet-stream;base64,[a-z0-9+/]+={0,2}$/i.test(
        image.data,
      )
    )
      throw new Error('Invalid embedded HDR/EXR environment.');
    result.image = { name: image.name, data: image.data };
  }
  if (result.mode === 'image' && !result.image)
    throw new Error('HDR/EXR environment image is missing.');
  if (raw.timeOfDay !== undefined)
    result.timeOfDay = parseTimeOfDay(raw.timeOfDay);
  if (result.timeOfDay?.enabled && result.mode !== 'sky')
    throw new Error(
      'Time of day requires the procedural sky. Disable the cycle to use a fixed HDR/EXR image.',
    );
  return result;
}
