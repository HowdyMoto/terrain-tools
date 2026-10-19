import { random } from './math';

export interface ErosionSettings {
  mode: 'hydraulic' | 'thermal' | 'both';
  seed: number;
  /** Droplets per terrain cell. */
  rainfall: number;
  /** Erosion kernel radius in grid cells. */
  radius: number;
  maxSteps: number;
  inertia: number;
  capacity: number;
  erosion: number;
  deposition: number;
  evaporation: number;
  /** Maximum excavation below the input surface, in metres. */
  maxDepth: number;
  thermalIterations: number;
  talus: number;
  thermalRate: number;
}
export const defaultErosionSettings = (): ErosionSettings => ({
  mode: 'both',
  seed: 42,
  rainfall: 2,
  radius: 2,
  maxSteps: 64,
  inertia: 0.15,
  capacity: 4,
  erosion: 0.3,
  deposition: 0.3,
  evaporation: 0.04,
  maxDepth: 12,
  thermalIterations: 12,
  talus: 35,
  thermalRate: 0.5,
});
export function parseErosionSettings(value: unknown): ErosionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid erosion settings.');
  const raw = value as Record<string, unknown>;
  if (!['hydraulic', 'thermal', 'both'].includes(raw.mode as string))
    throw new Error('Invalid erosion mode.');
  const result = { mode: raw.mode } as ErosionSettings;
  const ranges: Record<
    Exclude<keyof ErosionSettings, 'mode'>,
    [number, number, boolean?]
  > = {
    seed: [-2147483648, 2147483647, true],
    rainfall: [0, 8],
    radius: [1, 6, true],
    maxSteps: [8, 128, true],
    inertia: [0, 0.95],
    capacity: [0, 16],
    erosion: [0, 1],
    deposition: [0, 1],
    evaporation: [0.005, 0.5],
    maxDepth: [0, 10000],
    thermalIterations: [0, 200, true],
    talus: [0, 80],
    thermalRate: [0, 1],
  };
  for (const [key, [min, max, integer]] of Object.entries(ranges)) {
    const v = raw[key];
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < min ||
      v > max ||
      (integer && !Number.isInteger(v))
    )
      throw new Error('Invalid erosion ' + key + '.');
    (result as unknown as Record<string, unknown>)[key] = v;
  }
  return result;
}
export interface ErosionInput {
  resolution: number;
  size: number;
  heights: Float32Array;
  /** Effective cell holes, including prop cutouts. */
  holes: Uint8Array;
}
export interface ErosionProgress {
  phase: 'hydraulic' | 'thermal';
  completed: number;
  total: number;
}
export interface ErosionResult {
  heights: Float32Array;
  /** Hydraulic volumes in cubic metres; thermal transport has no net loss. */
  erodedVolume: number;
  depositedVolume: number;
  drainedVolume: number;
  maxChange: number;
}
/** Keep the outer boundary and vertices touching missing cells fixed. */
export function erosionMask(resolution: number, holes: Uint8Array): Uint8Array {
  const side = resolution + 1,
    mask = new Uint8Array(side * side);
  for (let z = 1; z < resolution; z++)
    for (let x = 1; x < resolution; x++) {
      const cell = z * resolution + x;
      mask[z * side + x] =
        holes[cell] ||
        holes[cell - 1] ||
        holes[cell - resolution] ||
        holes[cell - resolution - 1]
          ? 0
          : 1;
    }
  return mask;
}
export interface ThermalRegion {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
/**
 * Conservative eight-neighbour talus transport. Simultaneous pair transfers
 * form a convex update (at most eight contributions of 1/8), so heights remain
 * inside their previous extrema without clipping away sediment.
 */
export function thermalStep(
  heights: Float32Array | Float64Array,
  resolution: number,
  spacing: number,
  talus: number,
  rate: number,
  weight: (x: number, z: number) => number,
  region: ThermalRegion = {
    minX: 0,
    maxX: resolution,
    minZ: 0,
    maxZ: resolution,
  },
) {
  const x0 = Math.max(0, Math.floor(region.minX)),
    x1 = Math.min(resolution, Math.ceil(region.maxX));
  const z0 = Math.max(0, Math.floor(region.minZ)),
    z1 = Math.min(resolution, Math.ceil(region.maxZ));
  if (x1 < x0 || z1 < z0 || rate <= 0) return;
  const width = x1 - x0 + 1,
    delta = new Float64Array(width * (z1 - z0 + 1));
  const side = resolution + 1,
    slope = Math.tan((talus * Math.PI) / 180) * spacing;
  const pairs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [-1, 1],
  ];
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const w = weight(x, z);
      if (w <= 0) continue;
      const i = z * side + x,
        local = (z - z0) * width + x - x0;
      for (const [dx, dz] of pairs) {
        const nx = x + dx,
          nz = z + dz;
        if (nx < x0 || nx > x1 || nz > z1) continue;
        // A diagonal may not jump across a protected vertex.
        let influence = Math.min(w, weight(nx, nz));
        if (dx && dz)
          influence = Math.min(influence, weight(nx, z), weight(x, nz));
        if (influence <= 0) continue;
        const difference = heights[i] - heights[nz * side + nx];
        const excess = Math.max(
          0,
          Math.abs(difference) - slope * Math.hypot(dx, dz),
        );
        const amount =
          (Math.sign(difference) * excess * Math.min(1, rate) * influence) / 8;
        delta[local] -= amount;
        delta[(nz - z0) * width + nx - x0] += amount;
      }
    }
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++)
      heights[z * side + x] += delta[(z - z0) * width + x - x0];
}
/**
 * Seeded particle erosion followed by optional thermal settling. The input is
 * never mutated. Consume the generator in a worker for cancellable authoring.
 * This is an artistic heightfield process, not a calibrated hydrology solver.
 */
export function* erodeTerrain(
  input: ErosionInput,
  options: ErosionSettings,
): Generator<ErosionProgress, ErosionResult> {
  const settings = parseErosionSettings(options);
  const { resolution: n, size, heights: original, holes } = input;
  if (
    !Number.isInteger(n) ||
    n < 8 ||
    n > 512 ||
    !Number.isFinite(size) ||
    size < 8 ||
    size > 10000 ||
    !(original instanceof Float32Array) ||
    original.length !== (n + 1) ** 2 ||
    !(holes instanceof Uint8Array) ||
    holes.length !== n * n ||
    holes.some((v) => v > 1) ||
    original.some((v) => !Number.isFinite(v) || Math.abs(v) > size)
  )
    throw new Error('Invalid erosion terrain.');
  const side = n + 1,
    spacing = size / n;
  // Cell units keep flow direction/energy independent of an arbitrary world scale.
  const h = Float64Array.from(original, (v) => v / spacing);
  const floor = Float64Array.from(h, (v) =>
    Math.max(-n, v - settings.maxDepth / spacing),
  );
  const mask = erosionMask(n, holes),
    rng = random(settings.seed);
  const active = (x: number, z: number) => mask[z * side + x] ?? 0;
  const validCell = (x: number, z: number) =>
    x >= 0 &&
    z >= 0 &&
    x < n &&
    z < n &&
    active(Math.floor(x), Math.floor(z)) &&
    active(Math.floor(x) + 1, Math.floor(z)) &&
    active(Math.floor(x), Math.floor(z) + 1) &&
    active(Math.floor(x) + 1, Math.floor(z) + 1);
  const sample = (x: number, z: number) => {
    const ix = Math.floor(x),
      iz = Math.floor(z),
      u = x - ix,
      v = z - iz;
    const i = iz * side + ix,
      a = h[i],
      b = h[i + 1],
      c = h[i + side],
      d = h[i + side + 1];
    return {
      height:
        a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v,
      dx: (b - a) * (1 - v) + (d - c) * v,
      dz: (c - a) * (1 - u) + (d - b) * u,
    };
  };
  let eroded = 0,
    deposited = 0,
    drained = 0;
  const deposit = (x: number, z: number, amount: number) => {
    const ix = Math.floor(x),
      iz = Math.floor(z),
      u = x - ix,
      v = z - iz;
    let placed = 0;
    for (let dz = 0; dz < 2; dz++)
      for (let dx = 0; dx < 2; dx++) {
        const i = (iz + dz) * side + ix + dx;
        const share = amount * (dx ? u : 1 - u) * (dz ? v : 1 - v);
        const take = Math.min(share, Math.max(0, n - h[i]));
        h[i] += take;
        placed += take;
      }
    deposited += placed;
    return placed;
  };
  const kernel: [number, number, number][] = [];
  for (let dz = -settings.radius; dz <= settings.radius; dz++)
    for (let dx = -settings.radius; dx <= settings.radius; dx++) {
      const w = Math.max(0, 1 - Math.hypot(dx, dz) / settings.radius);
      if (w > 0) kernel.push([dx, dz, w]);
    }
  // A summed mask marks kernels entirely on editable ground. Only kernels near
  // holes/boundaries need per-offset reachability checks; storage remains O(vertices).
  const prefixSide = side + 1,
    prefix = new Uint32Array(prefixSide * prefixSide);
  for (let z = 0; z < side; z++) {
    let row = 0;
    for (let x = 0; x < side; x++) {
      row += mask[z * side + x] ? 0 : 1;
      prefix[(z + 1) * prefixSide + x + 1] =
        prefix[z * prefixSide + x + 1] + row;
    }
  }
  const clearKernel = new Uint8Array(mask.length),
    r = settings.radius;
  for (let z = r; z < side - r; z++)
    for (let x = r; x < side - r; x++) {
      const x0 = x - r,
        x1 = x + r + 1,
        z0 = z - r,
        z1 = z + r + 1;
      clearKernel[z * side + x] =
        prefix[z1 * prefixSide + x1] -
          prefix[z0 * prefixSide + x1] -
          prefix[z1 * prefixSide + x0] +
          prefix[z0 * prefixSide + x0] ===
        0
          ? 1
          : 0;
    }
  // Precompute only offsets; never allocate a kernel for every terrain vertex.
  const reachable = (x: number, z: number, dx: number, dz: number) => {
    const steps = Math.max(Math.abs(dx), Math.abs(dz), 1);
    for (let i = 1; i <= steps; i++) {
      const sx = x + Math.round((dx * i) / steps),
        sz = z + Math.round((dz * i) / steps);
      if (sx < 0 || sx > n || sz < 0 || sz > n || !active(sx, sz)) return false;
      if (
        dx &&
        dz &&
        (!active(sx, z + Math.round((dz * (i - 1)) / steps)) ||
          !active(x + Math.round((dx * (i - 1)) / steps), sz))
      )
        return false;
    }
    return true;
  };
  const indices = new Int32Array(kernel.length),
    weights = new Float64Array(kernel.length);
  const rainfall =
    settings.mode === 'thermal' ? 0 : Math.ceil(n * n * settings.rainfall);
  const iterations =
    settings.mode === 'hydraulic' ? 0 : settings.thermalIterations;
  const thermalWork = Math.ceil(
    (n * n * 8) / (settings.maxSteps * kernel.length),
  );
  const total = rainfall + iterations * thermalWork;
  for (let drop = 0; drop < rainfall; drop++) {
    let x = 1 + rng() * (n - 2),
      z = 1 + rng() * (n - 2);
    if (validCell(x, z)) {
      let dx = 0,
        dz = 0,
        speed = 1,
        water = 1,
        sediment = 0,
        outflow = false;
      for (let age = 0; age < settings.maxSteps && water > 0.01; age++) {
        const at = sample(x, z);
        dx = dx * settings.inertia - at.dx * (1 - settings.inertia);
        dz = dz * settings.inertia - at.dz * (1 - settings.inertia);
        const length = Math.hypot(dx, dz);
        if (length < 1e-10) break;
        dx /= length;
        dz /= length;
        const nx = x + dx,
          nz = z + dz;
        // Midpoint prevents diagonal paths slipping across a missing cell corner.
        if (!validCell(nx, nz) || !validCell(x + dx * 0.5, z + dz * 0.5)) {
          outflow = true;
          break;
        }
        const next = sample(nx, nz),
          dh = next.height - at.height;
        const capacity = Math.max(0, -dh) * speed * water * settings.capacity;
        if (dh > 0 || sediment > capacity) {
          const amount =
            dh > 0
              ? Math.min(sediment, dh)
              : (sediment - capacity) * settings.deposition;
          sediment -= deposit(x, z, amount);
        } else {
          // Rate also scales the downhill-height limit, so it remains effective
          // on steep slopes where carrying capacity is already plentiful.
          const requested =
            Math.min(capacity - sediment, -dh) * settings.erosion;
          if (requested > 0) {
            const ix = Math.floor(x),
              iz = Math.floor(z);
            let count = 0,
              sum = 0;
            for (const [kx, kz, weight] of kernel) {
              if (!clearKernel[iz * side + ix] && !reachable(ix, iz, kx, kz))
                continue;
              indices[count] = (iz + kz) * side + ix + kx;
              weights[count++] = weight;
              sum += weight;
            }
            for (let j = 0; j < count; j++) {
              const i = indices[j],
                available = Math.max(0, h[i] - Math.max(floor[i], next.height));
              const take = Math.min(available, (requested * weights[j]) / sum);
              h[i] -= take;
              sediment += take;
              eroded += take;
            }
          }
        }
        speed = Math.sqrt(Math.max(0, speed * speed - dh * 8));
        water *= 1 - settings.evaporation;
        x = nx;
        z = nz;
      }
      // Evaporation/end-of-life deposits the load; edges and holes drain it.
      if (!outflow) sediment -= deposit(x, z, sediment);
      drained += Math.max(0, sediment);
    }
    if ((drop + 1) % 256 === 0 || drop + 1 === rainfall)
      yield { phase: 'hydraulic', completed: drop + 1, total };
  }
  for (let iteration = 0; iteration < iterations; iteration++) {
    thermalStep(h, n, 1, settings.talus, settings.thermalRate, active);
    yield {
      phase: 'thermal',
      completed: rainfall + (iteration + 1) * thermalWork,
      total,
    };
  }
  const heights = Float32Array.from(h, (v) => v * spacing);
  let maxChange = 0;
  for (let i = 0; i < heights.length; i++)
    maxChange = Math.max(maxChange, Math.abs(heights[i] - original[i]));
  const volume = spacing ** 3;
  return {
    heights,
    erodedVolume: eroded * volume,
    depositedVolume: deposited * volume,
    drainedVolume: drained * volume,
    maxChange,
  };
}
export function runErosion(
  input: ErosionInput,
  settings: ErosionSettings,
): ErosionResult {
  const job = erodeTerrain(input, settings);
  let next = job.next();
  while (!next.done) next = job.next();
  return next.value;
}
