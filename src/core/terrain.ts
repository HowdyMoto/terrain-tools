import { propFootprint } from './props';
import { DEFAULT_EYE_HEIGHT } from './project-settings';
import { environmentPreset } from './environment';
import { erosionMask, thermalStep } from './erosion';
import { sampleHeightmap } from './heightmap';
import { clamp, fbm, lerp, random, smoothstep } from './math';
import { foliageModels, FoliageSpacing } from './foliage';
import type {
  BrushStroke,
  FoliageBrush,
  MaterialLayer,
  TerrainMeshData,
  TerrainProject,
} from './types';

export function createProject(
  resolution = 128,
  size = 192,
  seed = 42,
): TerrainProject {
  if (
    !Number.isInteger(resolution) ||
    resolution < 8 ||
    resolution > 512 ||
    !Number.isFinite(size) ||
    size < 8 ||
    size > 10000
  )
    throw new Error(
      'Resolution must be 8–512 cells; size must be 8–10000 metres.',
    );
  const layer = (
    id: string,
    name: string,
    color: string,
    minHeight: number,
    maxHeight: number,
    minSlope: number,
    maxSlope: number,
    roughness: number,
  ): MaterialLayer => ({
    id,
    name,
    color,
    minHeight,
    maxHeight,
    minSlope,
    maxSlope,
    roughness,
    metalness: 0,
    feather: 5,
    tileSize: 8,
    blendHeight: 0.35,
    textures: {},
  });
  const p: TerrainProject = {
    version: 1,
    environment: environmentPreset('daylight'),
    name: 'Alpine study',
    size,
    resolution,
    seed,
    heights: new Float32Array((resolution + 1) ** 2),
    holes: new Uint8Array(resolution ** 2),
    paint: new Float32Array((resolution + 1) ** 2 * 4),
    materials: [
      layer('grass', 'Meadow', '#677950', -30, 27, 0, 38, 0.94),
      layer('rock', 'Weathered rock', '#8b8980', -30, 100, 32, 90, 0.88),
      layer('sand', 'Alluvial soil', '#ad9770', -30, 6, 0, 38, 0.98),
      layer('snow', 'Summit snow', '#e5ece9', 27, 100, 0, 50, 0.68),
    ],
    brushes: [
      {
        id: 'pine',
        name: 'Alpine pines',
        model: 'pine',
        materials: ['grass'],
        minWeight: 0.55,
        density: 0.08,
        minScale: 0.7,
        maxScale: 1.5,
        rotation: 180,
        alignToNormal: false,
        maxSlope: 35,
        wind: 0.6,
        crush: 0.12,
        color: '#395a43',
      },
      {
        id: 'grass',
        name: 'Meadow tufts',
        model: 'grass',
        materials: ['grass', 'sand'],
        minWeight: 0.45,
        density: 0.5,
        minScale: 0.6,
        maxScale: 1.4,
        rotation: 180,
        alignToNormal: true,
        maxSlope: 48,
        wind: 1.2,
        crush: 1,
        color: '#85965a',
      },
    ],
    foliage: [],
    props: [],
    assets: {},
    wind: { enabled: true, strength: 0.5, direction: 45, gust: 0.4, speed: 1 },
    interaction: { enabled: true, radius: 4, strength: 1, recovery: 2.5 },
    view: {
      lowPoly: false,
      wireframe: false,
      water: true,
      waterLevel: 1,
      eyeHeight: DEFAULT_EYE_HEIGHT,
    },
    nextId: 1,
  };
  generateTerrain(p, 'alpine');
  return p;
}
export function generateTerrain(
  p: TerrainProject,
  preset: 'alpine' | 'dunes' | 'islands' | 'flat',
) {
  const n = p.resolution;
  for (let z = 0; z <= n; z++)
    for (let x = 0; x <= n; x++) {
      const nx = x / n,
        nz = z / n,
        f = fbm(nx * 4, nz * 4, p.seed);
      const ridge = 1 - Math.abs(f * 2 - 1);
      let h = 0;
      if (preset === 'alpine')
        h =
          (Math.pow(ridge, 3) * 35 + f * 15 - 15) *
          (0.5 + 0.5 * Math.sin(nx * Math.PI) * Math.sin(nz * Math.PI));
      if (preset === 'dunes')
        h = (Math.sin(nx * 25 + f * 5) * 0.5 + 0.5) ** 2 * 9 + f * 4;
      if (preset === 'islands')
        h = f * 32 - 9 - Math.hypot(nx - 0.5, nz - 0.5) * 20;
      p.heights[z * (n + 1) + x] = h * (p.size / 192);
    }
  p.holes.fill(0);
  p.paint.fill(0);
  p.foliage = [];
  p.props = [];
}
export function gridPosition(p: TerrainProject, x: number, z: number) {
  return [(x / p.size + 0.5) * p.resolution, (z / p.size + 0.5) * p.resolution];
}
export function heightAt(p: TerrainProject, x: number, z: number) {
  const [gx, gz] = gridPosition(p, x, z),
    n = p.resolution;
  const ix = clamp(Math.floor(gx), 0, n - 1),
    iz = clamp(Math.floor(gz), 0, n - 1),
    u = clamp(gx - ix),
    v = clamp(gz - iz),
    i = iz * (n + 1) + ix;
  const a = p.heights[i],
    b = p.heights[i + 1],
    c = p.heights[i + n + 1],
    d = p.heights[i + n + 2];
  // Match the actual mesh diagonal, including collision and prop anchoring.
  return u + v <= 1
    ? a + (b - a) * u + (c - a) * v
    : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}
export function slopeAt(p: TerrainProject, x: number, z: number) {
  const e = p.size / p.resolution;
  const dx = (heightAt(p, x + e, z) - heightAt(p, x - e, z)) / (2 * e),
    dz = (heightAt(p, x, z + e) - heightAt(p, x, z - e)) / (2 * e);
  return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
}
export function effectiveHoles(p: TerrainProject) {
  const holes = p.holes.slice(),
    n = p.resolution,
    step = p.size / n;
  for (const prop of p.props) {
    if (!prop.cutHole) continue;
    const footprint = propFootprint(prop),
      bounds = footprint.bounds;
    const minX = Math.max(0, Math.floor((bounds.minX + p.size / 2) / step));
    const maxX = Math.min(n, Math.ceil((bounds.maxX + p.size / 2) / step));
    const minZ = Math.max(0, Math.floor((bounds.minZ + p.size / 2) / step));
    const maxZ = Math.min(n, Math.ceil((bounds.maxZ + p.size / 2) / step));
    for (let z = minZ; z < maxZ; z++)
      for (let x = minX; x < maxX; x++)
        if (
          footprint.contains(
            (x + 0.5) * step - p.size / 2,
            (z + 0.5) * step - p.size / 2,
          )
        )
          holes[z * n + x] = 1;
  }
  return holes;
}
export function isHole(
  p: TerrainProject,
  x: number,
  z: number,
  holes: Uint8Array = effectiveHoles(p),
) {
  const [gx, gz] = gridPosition(p, x, z);
  if (gx < 0 || gz < 0 || gx >= p.resolution || gz >= p.resolution) return true;
  return holes[Math.floor(gz) * p.resolution + Math.floor(gx)] === 1;
}
function band(value: number, min: number, max: number, feather: number) {
  const f = Math.max(0.001, feather);
  return (
    smoothstep(min - f, min + f, value) *
    (1 - smoothstep(max - f, max + f, value))
  );
}
export function materialWeights(
  p: TerrainProject,
  x: number,
  z: number,
): number[] {
  const h = heightAt(p, x, z),
    slope = slopeAt(p, x, z),
    [gx, gz] = gridPosition(p, x, z),
    n = p.resolution;
  const ix = clamp(Math.round(gx), 0, n),
    iz = clamp(Math.round(gz), 0, n),
    offset = (iz * (n + 1) + ix) * 4;
  const weights = p.materials.map(
    (m) =>
      band(h, m.minHeight, m.maxHeight, m.feather) *
      band(slope, m.minSlope, m.maxSlope, m.feather),
  );
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum < 1e-8) {
    weights.fill(0);
    weights[0] = 1;
  } else for (let i = 0; i < 4; i++) weights[i] /= sum;
  let paintSum = 0;
  for (let i = 0; i < 4; i++) paintSum += p.paint[offset + i];
  for (let i = 0; i < 4; i++)
    weights[i] = weights[i] * (1 - clamp(paintSum)) + p.paint[offset + i];
  return weights;
}
export function applyBrush(p: TerrainProject, s: BrushStroke) {
  const n = p.resolution,
    step = p.size / n,
    [gx, gz] = gridPosition(p, s.x, s.z),
    gr = s.radius / step;
  const isStamp = s.tool === 'stamp',
    angle = s.rotation ?? 0;
  const cosine = Math.cos(angle),
    sine = Math.sin(angle);
  const bound = gr * (isStamp ? Math.abs(cosine) + Math.abs(sine) : 1);
  if (s.radius <= 0 || s.strength <= 0) return;
  if (s.tool === 'foliage') {
    paintFoliage(p, s.brushId, s.x, s.z, s.radius, s.strength, s.seed);
    return;
  }
  if (s.tool === 'erase') {
    p.foliage = p.foliage.filter(
      (f) => Math.hypot(f.x - s.x, f.z - s.z) > s.radius,
    );
    return;
  }
  if (s.tool === 'erode') {
    const mask = erosionMask(n, effectiveHoles(p));
    thermalStep(
      p.heights,
      n,
      step,
      clamp(s.talus ?? 35, 0, 80),
      clamp(s.strength * 0.3),
      (x, z) => {
        if (!mask[z * (n + 1) + x]) return 0;
        const dx = x - gx,
          dz = z - gz,
          d = Math.hypot(dx, dz) / gr;
        if (d >= 1) return 0;
        const weight = 1 - smoothstep(1 - clamp(s.falloff, 0.01, 1), 1, d);
        return (
          weight *
          (s.alpha
            ? sampleHeightmap(
                s.alpha,
                ((cosine * dx - sine * dz) / gr + 1) / 2,
                ((sine * dx + cosine * dz) / gr + 1) / 2,
              )
            : 1)
        );
      },
      { minX: gx - gr, maxX: gx + gr, minZ: gz - gr, maxZ: gz + gr },
    );
    return;
  }
  const isCell = s.tool === 'hole' || s.tool === 'fill';
  const old = s.tool === 'smooth' ? p.heights.slice() : p.heights;
  for (
    let z = Math.max(0, Math.floor(gz - bound));
    z <= Math.min(n - (isCell ? 1 : 0), Math.ceil(gz + bound));
    z++
  )
    for (
      let x = Math.max(0, Math.floor(gx - bound));
      x <= Math.min(n - (isCell ? 1 : 0), Math.ceil(gx + bound));
      x++
    ) {
      const dx = x + (isCell ? 0.5 : 0) - gx,
        dz = z + (isCell ? 0.5 : 0) - gz;
      const lx = (cosine * dx - sine * dz) / gr,
        lz = (sine * dx + cosine * dz) / gr;
      const d = isStamp
        ? Math.max(Math.abs(lx), Math.abs(lz))
        : Math.hypot(dx, dz) / gr;
      if (d > 1) continue;
      const w = 1 - smoothstep(1 - clamp(s.falloff, 0.01, 1), 1, d),
        alpha = s.alpha
          ? sampleHeightmap(s.alpha, (lx + 1) / 2, (lz + 1) / 2)
          : 1,
        power = w * s.strength * alpha,
        i = z * (n + 1) + x,
        h = old[i];
      if (isCell) {
        p.holes[z * n + x] = s.tool === 'hole' ? 1 : 0;
        continue;
      }
      if (isStamp) {
        p.heights[i] =
          s.stampMode === 'set'
            ? lerp(
                h,
                (s.stampBase ?? 0) + s.target * alpha,
                clamp(w * s.strength),
              )
            : h + s.target * power * (s.stampMode === 'subtract' ? -1 : 1);
      }
      if (s.tool === 'raise' || s.tool === 'lower')
        p.heights[i] += power * (s.tool === 'raise' ? 1 : -1);
      if (s.tool === 'flatten')
        p.heights[i] = lerp(h, s.target, clamp(power * 0.2));
      if (s.tool === 'terrace')
        p.heights[i] = lerp(
          h,
          Math.round(h / Math.max(0.1, s.target)) * Math.max(0.1, s.target),
          clamp(power * 0.3),
        );
      if (s.tool === 'noise')
        p.heights[i] += (fbm(x * 0.3, z * 0.3, s.seed) - 0.5) * power * 2;
      if (s.tool === 'smooth') {
        let total = 0,
          count = 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++)
            if (x + dx >= 0 && x + dx <= n && z + dz >= 0 && z + dz <= n) {
              total += old[(z + dz) * (n + 1) + x + dx];
              count++;
            }
        const avg = total / count;
        p.heights[i] = lerp(h, avg, clamp(power * 0.3));
      }
      if (s.tool === 'material') {
        const a = clamp(power * 0.25);
        for (let m = 0; m < 4; m++)
          p.paint[i * 4 + m] = lerp(
            p.paint[i * 4 + m],
            m === s.material ? 1 : 0,
            a,
          );
      }
      p.heights[i] = clamp(p.heights[i], -p.size, p.size);
    }
}
/** Paint respects the same mixed-model, spacing, and surface rules as population. */
export function paintFoliage(
  p: TerrainProject,
  brushId: string,
  x: number,
  z: number,
  radius: number,
  strength: number,
  seed: number,
  maximum = 50000,
  shape: 'disc' | 'square' = 'disc',
) {
  const brush = p.brushes.find((b) => b.id === brushId);
  if (!brush || radius <= 0 || strength <= 0) return 0;
  const spacing = new FoliageSpacing(
    brush.spacing ?? 0,
    p.foliage.filter((f) => f.brushId === brushId),
  );
  return scatterFoliage(
    p,
    brush,
    x,
    z,
    radius,
    strength,
    seed,
    Math.min(50000, maximum),
    shape,
    effectiveHoles(p),
    spacing,
  );
}
function scatterFoliage(
  p: TerrainProject,
  brush: FoliageBrush,
  x: number,
  z: number,
  radius: number,
  strength: number,
  seed: number,
  maximum: number,
  shape: 'disc' | 'square',
  holes: Uint8Array,
  spacing: FoliageSpacing,
) {
  const models = foliageModels(brush).filter((m) => m.weight > 0);
  const totalWeight = models.reduce((sum, m) => sum + m.weight, 0);
  if (!totalWeight || !brush.materials.length) return 0;
  const rng = random(seed),
    attempts = Math.min(
      10000,
      Math.ceil(
        (shape === 'square' ? 4 : Math.PI) *
          radius *
          radius *
          brush.density *
          strength,
      ),
    );
  let added = 0;
  for (let i = 0; i < attempts && p.foliage.length < maximum; i++) {
    const a = rng(),
      b = rng(),
      angle = a * Math.PI * 2,
      r = Math.sqrt(b) * radius,
      fx =
        x + (shape === 'square' ? (a * 2 - 1) * radius : Math.cos(angle) * r),
      fz =
        z + (shape === 'square' ? (b * 2 - 1) * radius : Math.sin(angle) * r);
    if (
      isHole(p, fx, fz, holes) ||
      !spacing.allows(fx, fz) ||
      slopeAt(p, fx, fz) > brush.maxSlope
    )
      continue;
    const weights = materialWeights(p, fx, fz),
      allowedWeight = p.materials.reduce(
        (sum, m, j) => sum + (brush.materials.includes(m.id) ? weights[j] : 0),
        0,
      );
    if (allowedWeight < brush.minWeight) continue;
    // Keep legacy RNG/placement unchanged until a brush becomes a mixture.
    let selected = models[0];
    if (brush.models) {
      let pick = rng() * totalWeight;
      for (const model of models) {
        pick -= model.weight;
        if (pick < 0) {
          selected = model;
          break;
        }
      }
    }
    const instance = {
      id: p.nextId++,
      brushId: brush.id,
      ...(brush.models ? { modelId: selected.id } : {}),
      x: fx,
      z: fz,
      scale: lerp(selected.minScale, selected.maxScale, rng()),
      rotation:
        (lerp(selected.minRotation, selected.maxRotation, rng()) * Math.PI) /
        180,
    };
    p.foliage.push(instance);
    spacing.add(instance);
    added++;
  }
  return added;
}
export function populateFoliage(
  p: TerrainProject,
  brushId: string,
  seed = p.seed,
) {
  const brush = p.brushes.find((b) => b.id === brushId);
  if (!brush) return 0;
  p.foliage = p.foliage.filter((f) => f.brushId !== brushId);
  const holes = effectiveHoles(p),
    spacing = new FoliageSpacing(brush.spacing ?? 0, []);
  let added = 0;
  const tiles = 8,
    width = p.size / tiles;
  for (let z = 0; z < tiles; z++)
    for (let x = 0; x < tiles; x++)
      added += scatterFoliage(
        p,
        brush,
        -p.size / 2 + (x + 0.5) * width,
        -p.size / 2 + (z + 0.5) * width,
        width / 2,
        1,
        seed + z * tiles + x,
        50000,
        'square',
        holes,
        spacing,
      );
  return added;
}
export function buildMeshData(
  p: TerrainProject,
  startX = 0,
  startZ = 0,
  cellsX = p.resolution,
  cellsZ = p.resolution,
  holes = effectiveHoles(p),
  includeWeights = true,
): TerrainMeshData {
  const positions = new Float32Array((cellsX + 1) * (cellsZ + 1) * 3),
    weights = new Float32Array(
      includeWeights ? (cellsX + 1) * (cellsZ + 1) * 4 : 0,
    ),
    indices: number[] = [],
    n = p.resolution;
  for (let z = 0; z <= cellsZ; z++)
    for (let x = 0; x <= cellsX; x++) {
      const i = z * (cellsX + 1) + x,
        px = ((startX + x) / n) * p.size - p.size / 2,
        pz = ((startZ + z) / n) * p.size - p.size / 2;
      positions.set(
        [px, p.heights[(startZ + z) * (n + 1) + startX + x], pz],
        i * 3,
      );
      if (includeWeights) weights.set(materialWeights(p, px, pz), i * 4);
      if (x < cellsX && z < cellsZ && !holes[(startZ + z) * n + startX + x]) {
        const a = i,
          b = a + 1,
          c = a + cellsX + 1,
          d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  return { positions, weights, indices: new Uint32Array(indices) };
}
