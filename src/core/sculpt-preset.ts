import { createProject } from './terrain';
import { validateProjectData } from './serialization';
import { defaultSculptBrushSettings } from './sculpt';
import type { SculptBrushSettings, SculptSettings } from './types';

/** A portable tool configuration; terrain, placements and surface assets are excluded. */
export interface SculptPreset {
  settings: SculptSettings & { brush: SculptBrushSettings };
  /** Thermal brush angle of repose in degrees; other weathering controls are unchanged. */
  talus: number;
}
export const MAX_SCULPT_PRESET_BYTES = 8 * 1024 * 1024;

function validatePreset(settings: unknown, talus: unknown): SculptPreset {
  if (
    typeof talus !== 'number' ||
    !Number.isFinite(talus) ||
    talus < 0 ||
    talus > 80
  )
    throw new Error('Invalid sculpt preset stable slope.');
  const project = createProject(8, 8);
  const validated = validateProjectData({
    ...project,
    sculpt: settings,
  }).sculpt;
  if (!validated) throw new Error('Sculpt preset settings are missing.');
  const {
    alphaKind,
    alpha,
    alphaName,
    rotation,
    stampHeight,
    stampBase,
    stampMode,
    pressure,
  } = validated;
  return {
    settings: {
      brush: validated.brush ?? defaultSculptBrushSettings(),
      alphaKind,
      ...(alpha ? { alpha } : {}),
      ...(alphaName !== undefined ? { alphaName } : {}),
      rotation,
      stampHeight,
      stampBase,
      stampMode,
      pressure,
    },
    talus,
  };
}

/** Validate and serialize independently owned, full-precision alpha samples. */
export function serializeSculptPreset(
  settings: SculptSettings,
  talus = 35,
): string {
  const preset = validatePreset(settings, talus);
  const text = JSON.stringify({
    kind: 'terrain-sculpt-preset',
    version: 1,
    ...preset,
    settings: {
      ...preset.settings,
      ...(preset.settings.alpha
        ? {
            alpha: {
              ...preset.settings.alpha,
              values: Array.from(preset.settings.alpha.values),
            },
          }
        : {}),
    },
  });
  if (new TextEncoder().encode(text).byteLength > MAX_SCULPT_PRESET_BYTES)
    throw new Error('Sculpt preset exceeds the 8 MiB file limit.');
  return text;
}

/** No live document is modified; reject malformed files before applying a preset. */
export function parseSculptPreset(text: string): SculptPreset {
  if (
    text.length > MAX_SCULPT_PRESET_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_SCULPT_PRESET_BYTES
  )
    throw new Error('Sculpt preset exceeds the 8 MiB file limit.');
  const raw = JSON.parse(text);
  if (!raw || raw.kind !== 'terrain-sculpt-preset' || raw.version !== 1)
    throw new Error('Unsupported sculpt preset file.');
  if (!raw.settings?.brush)
    throw new Error('Sculpt preset brush settings are missing.');
  return validatePreset(raw.settings, raw.talus);
}
