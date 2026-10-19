import { createProject } from '../core/terrain';
import { waterPreset } from '../core/water';
import type { TerrainWorld } from '../core/world';
import { defaultFoliageSubsurface } from '../core/foliage-shading';

export const referenceWorld: TerrainWorld = {
  kind: 'terrain-world',
  version: 1,
  tileSize: 250,
  tiles: Array.from({ length: 64 }, (_, i) => ({
    x: i % 8,
    z: Math.floor(i / 8),
    source: 'reference:' + i,
  })),
};
export function referenceHeight(x: number, z: number) {
  return (
    12 +
    Math.sin(x * 0.009) * 8 +
    Math.cos(z * 0.011) * 7 +
    Math.sin((x + z) * 0.023) * 2 +
    Math.sin(x * 0.11) * Math.cos(z * 0.13) * 0.45 -
    Math.max(0, z - 1400) * 0.12
  );
}
/** Deterministic tile authoring, run in a worker; no world-sized terrain arrays. */
export function referenceTile(x: number, z: number) {
  const p = createProject(8, 250, 817 + x + z * 8),
    n = 128;
  p.name = `Reference ${x},${z}`;
  p.resolution = n;
  p.heights = new Float32Array((n + 1) ** 2);
  p.paint = new Float32Array((n + 1) ** 2 * 4);
  p.holes = new Uint8Array(n * n);
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const h = referenceHeight((x + i / n) * 250, (z + j / n) * 250),
        index = j * (n + 1) + i;
      p.heights[index] = h;
      p.paint[index * 4 + (h < 3 ? 1 : 0)] = 1;
    }
  p.view.water = z >= 5;
  p.view.textureResolution = 512;
  if (z >= 5)
    p.water = {
      schemaVersion: 1,
      seaLevel: 0,
      ocean: { enabled: true, surface: waterPreset('tropical') },
      bodies: [],
      reflections: true,
    };
  const model = (id: string, fern: boolean) => ({
    id,
    model: id,
    weight: 1,
    minScale: 0.8,
    maxScale: 1.2,
    minRotation: 0,
    maxRotation: 360,
    alignToNormal: fern,
    wind: fern ? 0.5 : 0.12,
    crush: fern ? 1 : 0,
    color: '#ffffff',
    cullDistance: fern ? 75 : 450,
    lodFadeDuration: 0.3,
    lodHysteresis: 0.12,
    subsurface: defaultFoliageSubsurface(),
    interaction: { enabled: fern, radius: 2, recovery: 2 },
    flexibility: {
      source: 'height' as const,
      start: 0,
      end: fern ? 0.8 : 1,
      exponent: fern ? 1 : 4,
    },
    lods: fern
      ? [{ model: id + '-low', distance: 25, density: 0.7 }]
      : [
          { model: id + '-mid', distance: 65, density: 1 },
          { model: id + '-low', distance: 150, density: 0.8 },
        ],
  });
  p.brushes = [p.brushes[0], { ...p.brushes[1] }];
  p.brushes[0].models = [model('ph-pine-b', false)];
  p.brushes[1].models = [model('ph-fern-a', true)];
  let seed = p.seed;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < (x < 4 ? 900 : 160); i++) {
    const lx = rand() * 250 - 125,
      lz = rand() * 250 - 125;
    if (referenceHeight((x + 0.5) * 250 + lx, (z + 0.5) * 250 + lz) < 3)
      continue;
    const fern = i % 3 !== 0;
    p.foliage.push({
      id: p.nextId++,
      brushId: p.brushes[fern ? 1 : 0].id,
      modelId: fern ? 'ph-fern-a' : 'ph-pine-b',
      x: lx,
      z: lz,
      scale: (fern ? 1.4 : 1) * (0.8 + rand() * 0.4),
      rotation: rand() * Math.PI * 2,
    });
  }
  return p;
}
