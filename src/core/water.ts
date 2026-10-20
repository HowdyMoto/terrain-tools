import type { TerrainProject } from './types';
import { effectiveHoles } from './terrain';

/** Distances are metres; directions are degrees clockwise from +X toward +Z. */
export interface WaterSurface {
  color: string;
  visibility: number;
  roughness: number;
  swellHeight: number;
  swellLength: number;
  waveHeight: number;
  waveLength: number;
  direction: number;
  speed: number;
  ripple: number;
  foam: number;
  foamWidth: number;
  /** Bank darkening (0..1), vertical reach above mean water (metres). */
  wetness: number;
  wetBand: number;
  /** Approximate animated light concentration on submerged terrain (0..1). */
  caustics: number;
  windLinked: boolean;
}
export type WaterExtent =
  | {
      kind: 'ellipse';
      x: number;
      z: number;
      radiusX: number;
      radiusZ: number;
      rotation: number;
    }
  | { kind: 'polygon'; points: { x: number; z: number }[] }
  | { kind: 'basin'; x: number; z: number };
export interface WaterBody {
  id: string;
  name: string;
  enabled: boolean;
  elevation: number;
  extent: WaterExtent;
  surface: WaterSurface;
}
/** Open-ocean spectral simulation; distances in metres, wind speed in m/s. */
export interface SpectralOceanSettings {
  quality: 'balanced' | 'high';
  windSpeed: number;
  fetch: number;
  choppiness: number;
  whitecaps: number;
  swellDirection: number;
  seed: number;
}
export function defaultSpectralOceanSettings(): SpectralOceanSettings {
  return {
    quality: 'balanced',
    windSpeed: 8,
    fetch: 50000,
    choppiness: 1,
    whitecaps: 0.8,
    swellDirection: 35,
    seed: 1,
  };
}
export interface WaterSettings {
  schemaVersion: 1;
  seaLevel: number;
  ocean: {
    enabled: boolean;
    surface: WaterSurface;
    renderer?: 'standard' | 'web-ocean';
    spectral?: SpectralOceanSettings;
  };
  bodies: WaterBody[];
  reflections: boolean;
}
export const WATER_PRESETS = {
  tropical: 'Clear tropical',
  lake: 'Calm lake',
  pond: 'Forest pond',
  muddy: 'Muddy water',
  ocean: 'Open ocean',
} as const;
export type WaterPreset = keyof typeof WATER_PRESETS;
export function waterPreset(preset: WaterPreset = 'tropical'): WaterSurface {
  const surface: WaterSurface = {
    color: '#188d83',
    visibility: 18,
    roughness: 0.09,
    swellHeight: 0.25,
    swellLength: 24,
    waveHeight: 0.09,
    waveLength: 5,
    direction: 35,
    speed: 1,
    ripple: 0.3,
    foam: 0.65,
    foamWidth: 1.2,
    wetness: 0.65,
    wetBand: 0.6,
    caustics: 0.45,
    windLinked: false,
  };
  if (preset === 'lake')
    Object.assign(surface, {
      color: '#367d77',
      visibility: 7,
      swellHeight: 0,
      waveHeight: 0.05,
      foam: 0.12,
      ripple: 0.2,
      caustics: 0.15,
    });
  if (preset === 'pond')
    Object.assign(surface, {
      color: '#586942',
      visibility: 1.8,
      swellHeight: 0,
      waveHeight: 0.025,
      foam: 0,
      ripple: 0.12,
      caustics: 0.04,
    });
  if (preset === 'muddy')
    Object.assign(surface, {
      color: '#84704b',
      visibility: 0.35,
      swellHeight: 0,
      waveHeight: 0.04,
      foam: 0.08,
      caustics: 0,
    });
  if (preset === 'ocean')
    Object.assign(surface, {
      color: '#205968',
      visibility: 10,
      swellHeight: 1.3,
      swellLength: 38,
      waveHeight: 0.3,
      waveLength: 7,
      ripple: 0.45,
      foam: 0.8,
      foamWidth: 2,
      caustics: 0.2,
    });
  return surface;
}
export function defaultWaterSettings(
  project: Pick<TerrainProject, 'view'>,
): WaterSettings {
  return {
    schemaVersion: 1,
    seaLevel: project.view.waterLevel,
    ocean: { enabled: project.view.water, surface: waterPreset() },
    bodies: [],
    reflections: true,
  };
}
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('Invalid water settings.');
  return v as Record<string, unknown>;
};
const number = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new Error(`Water value must be ${min}–${max}.`);
  return v;
};
const bool = (v: unknown) => {
  if (typeof v !== 'boolean') throw new Error('Invalid water toggle.');
  return v;
};
const name = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 120)
    throw new Error('Invalid water name or ID.');
  return v;
};
function parseSurface(v: unknown): WaterSurface {
  const s = record(v);
  if (typeof s.color !== 'string' || !/^#[\da-f]{6}$/i.test(s.color))
    throw new Error('Invalid water color.');
  return {
    color: s.color,
    visibility: number(s.visibility, 0.05, 200),
    roughness: number(s.roughness, 0.02, 1),
    swellHeight: number(s.swellHeight, 0, 10),
    swellLength: number(s.swellLength, 2, 500),
    waveHeight: number(s.waveHeight, 0, 3),
    waveLength: number(s.waveLength, 0.5, 50),
    direction: number(s.direction, -360, 360),
    speed: number(s.speed, 0, 3),
    ripple: number(s.ripple, 0, 1),
    foam: number(s.foam, 0, 1),
    foamWidth: number(s.foamWidth, 0.05, 20),
    wetness: number(s.wetness ?? 0, 0, 1),
    wetBand: number(s.wetBand ?? 0.6, 0.05, 3),
    caustics: number(s.caustics ?? 0, 0, 1),
    windLinked: bool(s.windLinked),
  };
}
function parseExtent(v: unknown): WaterExtent {
  const e = record(v),
    coord = (v: unknown) => number(v, -10000, 10000);
  if (e.kind === 'ellipse')
    return {
      kind: 'ellipse',
      x: coord(e.x),
      z: coord(e.z),
      radiusX: number(e.radiusX, 0.25, 10000),
      radiusZ: number(e.radiusZ, 0.25, 10000),
      rotation: number(e.rotation, -360, 360),
    };
  if (e.kind === 'basin')
    return { kind: 'basin', x: coord(e.x), z: coord(e.z) };
  if (
    e.kind !== 'polygon' ||
    !Array.isArray(e.points) ||
    e.points.length < 3 ||
    e.points.length > 128
  )
    throw new Error('Draw an outline with 3–128 points.');
  const points = e.points.map((v) => {
    const p = record(v);
    return { x: coord(p.x), z: coord(p.z) };
  });
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 0.01)
      throw new Error('Water outline contains duplicate points.');
    area += a.x * b.z - b.x * a.z;
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j],
        d = points[(j + 1) % points.length];
      const cross = (
        a: { x: number; z: number },
        b: { x: number; z: number },
        c: { x: number; z: number },
      ) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      if (
        cross(a, b, c) * cross(a, b, d) <= 0 &&
        cross(c, d, a) * cross(c, d, b) <= 0 &&
        Math.max(a.x, b.x) >= Math.min(c.x, d.x) &&
        Math.max(c.x, d.x) >= Math.min(a.x, b.x) &&
        Math.max(a.z, b.z) >= Math.min(c.z, d.z) &&
        Math.max(c.z, d.z) >= Math.min(a.z, b.z)
      )
        throw new Error('Water outline must not cross itself.');
    }
  }
  if (Math.abs(area) < 0.1) throw new Error('Water outline is too small.');
  return { kind: 'polygon', points };
}
/** Strict, detached normalization for files and staged authoring. */
export function parseWaterSettings(value: unknown): WaterSettings {
  const w = record(value),
    ocean = record(w.ocean);
  if (w.schemaVersion !== 1)
    throw new Error('Unsupported water settings version.');
  if (!Array.isArray(w.bodies) || w.bodies.length > 16)
    throw new Error('A project supports up to 16 local water bodies.');
  const ids = new Set<string>();
  if (
    ocean.renderer !== undefined &&
    ocean.renderer !== 'standard' &&
    ocean.renderer !== 'web-ocean'
  )
    throw new Error('Unknown ocean renderer.');
  let spectral: SpectralOceanSettings | undefined;
  if (ocean.spectral !== undefined) {
    const s = record(ocean.spectral);
    if (s.quality !== 'balanced' && s.quality !== 'high')
      throw new Error('Invalid spectral ocean quality.');
    spectral = {
      quality: s.quality,
      windSpeed: number(s.windSpeed, 0, 30),
      fetch: number(s.fetch, 1000, 800000),
      choppiness: number(s.choppiness, 0, 1.6),
      whitecaps: number(s.whitecaps, 0, 2),
      swellDirection: number(s.swellDirection, -360, 360),
      seed: number(s.seed, 0, 65535),
    };
    if (!Number.isInteger(spectral.seed))
      throw new Error('Ocean seed must be a whole number.');
  }
  return {
    schemaVersion: 1,
    seaLevel: number(w.seaLevel, -10000, 10000),
    ocean: {
      enabled: bool(ocean.enabled),
      surface: parseSurface(ocean.surface),
      ...(ocean.renderer !== undefined ? { renderer: ocean.renderer } : {}),
      ...(spectral ? { spectral } : {}),
    },
    reflections: bool(w.reflections),
    bodies: w.bodies.map((v) => {
      const b = record(v),
        id = name(b.id);
      if (ids.has(id) || id === 'ocean')
        throw new Error('Water body IDs must be unique.');
      ids.add(id);
      return {
        id,
        name: name(b.name),
        enabled: bool(b.enabled),
        elevation: number(b.elevation, -10000, 10000),
        extent: parseExtent(b.extent),
        surface: parseSurface(b.surface),
      };
    }),
  };
}
export function waterContains(
  extent: WaterExtent,
  x: number,
  z: number,
): boolean {
  if (extent.kind === 'basin') return true; // Connectivity is resolved by waterMasks.
  if (extent.kind === 'ellipse') {
    const a = (extent.rotation * Math.PI) / 180,
      dx = x - extent.x,
      dz = z - extent.z;
    return (
      ((dx * Math.cos(a) + dz * Math.sin(a)) / extent.radiusX) ** 2 +
        ((dz * Math.cos(a) - dx * Math.sin(a)) / extent.radiusZ) ** 2 <=
      1
    );
  }
  let inside = false;
  for (
    let i = 0, j = extent.points.length - 1;
    i < extent.points.length;
    j = i++
  ) {
    const a = extent.points[i],
      b = extent.points[j];
    if (
      a.z > z !== b.z > z &&
      x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
}
/** Cell masks. Only boundary-connected ocean cells fill; basin holes/borders are spill boundaries. */
export function waterMasks(project: TerrainProject, settings: WaterSettings) {
  const n = project.resolution,
    step = project.size / n,
    holes = effectiveHoles(project);
  const heights = new Float32Array(n * n);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const i = z * (n + 1) + x,
        h = project.heights;
      heights[z * n + x] = Math.min(h[i], h[i + 1], h[i + n + 1], h[i + n + 2]);
    }
  const flood = (level: number, seeds: number[]) => {
    const mask = new Uint8Array(n * n),
      queue = new Int32Array(n * n);
    let head = 0,
      tail = 0,
      spills = false;
    const visit = (i: number) => {
      if (!mask[i] && heights[i] < level) {
        mask[i] = 255;
        queue[tail++] = i;
      }
    };
    seeds.forEach(visit);
    while (head < tail) {
      const i = queue[head++],
        x = i % n,
        z = Math.floor(i / n);
      if (x === 0 || z === 0 || x === n - 1 || z === n - 1 || holes[i])
        spills = true;
      const vertex = z * (n + 1) + x,
        h = project.heights;
      if (x > 0 && Math.min(h[vertex], h[vertex + n + 1]) < level) visit(i - 1);
      if (x < n - 1 && Math.min(h[vertex + 1], h[vertex + n + 2]) < level)
        visit(i + 1);
      if (z > 0 && Math.min(h[vertex], h[vertex + 1]) < level) visit(i - n);
      if (z < n - 1 && Math.min(h[vertex + n + 1], h[vertex + n + 2]) < level)
        visit(i + n);
    }
    return { mask, spills, count: tail };
  };
  const edges: number[] = [];
  for (let i = 0; i < n; i++)
    edges.push(i, (n - 1) * n + i, i * n, i * n + n - 1);
  const ocean = flood(settings.seaLevel, edges).mask;
  const bodies = settings.bodies.map((body) => {
    if (body.extent.kind === 'basin') {
      const x = Math.floor((body.extent.x / project.size + 0.5) * n),
        z = Math.floor((body.extent.z / project.size + 0.5) * n);
      if (x < 0 || x >= n || z < 0 || z >= n)
        throw new Error(`${body.name}: basin seed is outside the terrain.`);
      const result = flood(body.elevation, [z * n + x]);
      return { id: body.id, ...result };
    }
    const mask = new Uint8Array(n * n);
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++)
        if (
          waterContains(
            body.extent,
            (x + 0.5) * step - project.size / 2,
            (z + 0.5) * step - project.size / 2,
          )
        )
          mask[z * n + x] = 255;
    return { id: body.id, mask, spills: false, count: 0 };
  });
  return { ocean, bodies };
}
