/** Local solar time: noon is the sun's meridian crossing, independent of time zones. */
export interface TimeOfDaySettings {
  enabled: boolean;
  playing: boolean;
  hour: number;
  dayOfYear: number;
  latitude: number;
  /** Clockwise orientation of geographic north from terrain +Z, in degrees. */
  northOffset: number;
  dayLengthMinutes: number;
  haze: number;
  rayleigh: number;
  nightBrightness: number;
  autoFog: boolean;
}

export function defaultTimeOfDay(): TimeOfDaySettings {
  return {
    enabled: false,
    playing: false,
    hour: 12,
    dayOfYear: 172,
    latitude: 35,
    northOffset: 0,
    dayLengthMinutes: 10,
    haze: 3,
    rayleigh: 2,
    nightBrightness: 0.03,
    autoFog: true,
  };
}

export function parseTimeOfDay(value: unknown): TimeOfDaySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid time-of-day settings.');
  const raw = value as Record<string, unknown>,
    result = {} as TimeOfDaySettings;
  for (const key of ['enabled', 'playing', 'autoFog'] as const) {
    if (typeof raw[key] !== 'boolean')
      throw new Error('Invalid time-of-day ' + key + '.');
    result[key] = raw[key];
  }
  const ranges = {
    hour: [0, 24],
    dayOfYear: [1, 365],
    latitude: [-90, 90],
    northOffset: [0, 360],
    dayLengthMinutes: [0.25, 1440],
    haze: [2, 20],
    rayleigh: [1, 4],
    nightBrightness: [0, 1],
  } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const v = raw[key],
      [min, max] = ranges[key];
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < min ||
      v > max ||
      (key === 'dayOfYear' && !Number.isInteger(v))
    )
      throw new Error('Invalid time-of-day ' + key + '.');
    result[key] = v;
  }
  return result;
}

export const wrapSolarHour = (hour: number) => ((hour % 24) + 24) % 24;
export function formatSolarTime(hour: number) {
  const minutes = Math.floor(wrapSolarHour(hour) * 60 + 1e-7);
  return (
    String(Math.floor(minutes / 60)).padStart(2, '0') +
    ':' +
    String(minutes % 60).padStart(2, '0')
  );
}

/** Approximate NOAA solar declination; a fixed season repeats seamlessly every 24 solar hours.
 * No longitude, civil timezone, leap-year correction, or atmospheric refraction is applied. */
export function solarPosition(
  settings: Pick<TimeOfDaySettings, 'latitude' | 'dayOfYear' | 'northOffset'>,
  hour: number,
) {
  const rad = Math.PI / 180,
    gamma = (2 * Math.PI * (settings.dayOfYear - 1)) / 365;
  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const latitude = settings.latitude * rad,
    angle = (wrapSolarHour(hour) - 12) * 15 * rad;
  const east = -Math.cos(declination) * Math.sin(angle);
  const up =
    Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(angle);
  const north =
    Math.cos(latitude) * Math.sin(declination) -
    Math.sin(latitude) * Math.cos(declination) * Math.cos(angle);
  const rotation = settings.northOffset * rad;
  const x = east * Math.cos(rotation) + north * Math.sin(rotation);
  const z = north * Math.cos(rotation) - east * Math.sin(rotation);
  return {
    x,
    y: up,
    z,
    elevation: Math.asin(Math.max(-1, Math.min(1, up))) / rad,
    azimuth: (Math.atan2(x, z) / rad + 360) % 360,
  };
}

function smooth(low: number, high: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** Artist-oriented daylight response; intensity is relative, not calibrated lux. */
export function daylightState(
  settings: TimeOfDaySettings,
  hour = settings.hour,
) {
  const sun = solarPosition(settings, hour);
  const day = smooth(-10, 2, sun.elevation);
  const airMass = 1 / Math.max(0.035, sun.y);
  const extinction = (airMass - 1) * (0.06 + settings.haze * 0.012);
  const direct = smooth(-0.8, 1, sun.elevation) * Math.exp(-extinction);
  const warmth = Math.exp(-extinction * 0.65);
  return {
    ...sun,
    hour: wrapSolarHour(hour),
    day,
    direct,
    sunColor: [1, warmth, warmth * warmth] as const,
    twilight:
      smooth(-12, -2, sun.elevation) * (1 - smooth(2, 18, sun.elevation)),
  };
}
