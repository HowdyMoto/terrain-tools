import { clamp, fbm, smoothstep } from './math';
import type { Heightmap } from './heightmap';
import type { SculptBrushSettings, SculptSettings } from './types';

export const SCULPT_BRUSH_TOOLS = [
  'raise',
  'lower',
  'smooth',
  'flatten',
  'terrace',
  'noise',
  'erode',
  'stamp',
  'hole',
  'fill',
] as const;
export function defaultSculptBrushSettings(): SculptBrushSettings {
  return {
    name: 'Sculpt brush',
    tool: 'raise',
    radius: 12,
    strength: 1,
    falloff: 0.65,
    target: 10,
  };
}
/** Parse a brush independently of scene size; terrain edits still clamp to scene bounds. */
export function parseSculptBrushSettings(raw: unknown): SculptBrushSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid sculpt brush settings.');
  const settings = raw as Record<string, unknown>;
  if (
    typeof settings.name !== 'string' ||
    !settings.name.trim() ||
    settings.name.length > 120
  )
    throw new Error('Invalid sculpt brush name.');
  if (
    !SCULPT_BRUSH_TOOLS.includes(settings.tool as SculptBrushSettings['tool'])
  )
    throw new Error('Invalid sculpt brush tool.');
  const number = (key: string, min: number, max: number) => {
    const value = settings[key];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    )
      throw new Error('Invalid sculpt brush ' + key + '.');
    return value;
  };
  return {
    name: settings.name,
    tool: settings.tool as SculptBrushSettings['tool'],
    radius: number('radius', 1, 50),
    strength: number('strength', 0.05, 5),
    falloff: number('falloff', 0.05, 1),
    target: number('target', -10000, 10000),
  };
}

export function defaultSculptSettings(): SculptSettings {
  return {
    brush: defaultSculptBrushSettings(),
    alphaKind: 'none',
    rotation: 0,
    stampHeight: 12,
    stampBase: 0,
    stampMode: 'add',
    pressure: true,
  };
}
const alphas = new Map<string, Heightmap>();
export function builtInAlpha(kind: 'round' | 'ridge' | 'crater'): Heightmap {
  const cached = alphas.get(kind);
  if (cached) return cached;
  const size = 129,
    values = new Float32Array(size * size);
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1,
        nz = (z / (size - 1)) * 2 - 1;
      const radius = Math.hypot(nx, nz),
        edge = 1 - smoothstep(0.7, 1, radius);
      let value = Math.exp(-radius * radius * 3);
      if (kind === 'ridge') {
        const offset = (fbm(nx * 3, nz * 3, 17) - 0.5) * 0.35;
        value =
          Math.exp(-Math.abs(nx + offset) * 6) *
          (0.55 + 0.45 * fbm(nx * 9, nz * 9, 8));
      }
      if (kind === 'crater') value = Math.exp(-(((radius - 0.58) / 0.16) ** 2));
      values[z * size + x] = clamp(value * edge);
    }
  const map = { width: size, height: size, values };
  alphas.set(kind, map);
  return map;
}
