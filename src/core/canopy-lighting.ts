import { heightAt, materialWeights } from './terrain';
import type { TerrainProject } from './types';

export interface CanopyOccluder {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  rotation?: number;
}
export interface CanopyLightInput {
  project: TerrainProject;
  occluders: CanopyOccluder[];
  colors: [number, number, number][];
  cells?: number;
}
export interface CanopyLightData {
  pixels: Float32Array;
  dimensions: [number, number, number];
  minimum: [number, number, number];
  size: [number, number, number];
  ground: Float32Array;
  groundRange: [number, number];
}
/** Approximate static canopy transmittance, not traced triangle GI. Twelve sky
 * rays integrate ellipsoid cover over 48 m; RGB stores bounded local ground tint.
 * The worker owns temporary data; the renderer owns the small resulting volume. */
export function bakeCanopyLight(input: CanopyLightInput): CanopyLightData {
  const { project: p, occluders } = input;
  const cells = input.cells ?? 24;
  if (
    !Number.isInteger(cells) ||
    cells < 4 ||
    cells > 32 ||
    occluders.length > 50000
  )
    throw new Error('Invalid canopy light field limits.');
  let minY = Infinity,
    maxY = -Infinity;
  for (const y of p.heights) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  let height = 4;
  for (const canopy of occluders)
    height = Math.max(
      height,
      canopy.y + canopy.ry - heightAt(p, canopy.x, canopy.z) + 1,
    );
  const minimum: CanopyLightData['minimum'] = [-p.size / 2, -0.5, -p.size / 2];
  const size: CanopyLightData['size'] = [p.size, Math.min(64, height), p.size];
  const dimensions: CanopyLightData['dimensions'] = [cells, 8, cells];
  const pixels = new Float32Array(cells * cells * 8 * 4);
  const groundPixels = new Float32Array(cells * cells);
  const groundRange: CanopyLightData['groundRange'] = [
    minY,
    Math.max(1, maxY - minY),
  ];
  const rays = Array.from({ length: 12 }, (_, index) => {
    const y = (index + 0.5) / 12,
      phi = index * 2.399963229728653,
      radius = Math.sqrt(1 - y * y);
    return [Math.cos(phi) * radius, y, Math.sin(phi) * radius];
  });
  type Crown = CanopyOccluder & {
    cosine: number;
    sine: number;
    directions: number[][];
    density: number;
  };
  const depths = new Float64Array(rays.length);
  const bins = new Map<string, Crown[]>(),
    cellSize = 16,
    reach = 48;
  const globalCanopies: Crown[] = [];
  for (const canopy of occluders) {
    if (
      ![
        canopy.x,
        canopy.y,
        canopy.z,
        canopy.rx,
        canopy.ry,
        canopy.rz,
        canopy.rotation ?? 0,
      ].every(Number.isFinite) ||
      Math.min(canopy.rx, canopy.ry, canopy.rz) <= 0
    )
      throw new Error('Invalid canopy bounds.');
    const cosine = Math.cos(canopy.rotation ?? 0),
      sine = Math.sin(canopy.rotation ?? 0);
    const crown: Crown = {
      ...canopy,
      cosine,
      sine,
      density: 1.4 / Math.max(canopy.rx, canopy.ry, canopy.rz),
      directions: rays.map((ray) => {
        const dx = (ray[0] * cosine - ray[2] * sine) / canopy.rx,
          dy = ray[1] / canopy.ry,
          dz = (ray[0] * sine + ray[2] * cosine) / canopy.rz;
        return [dx, dy, dz, dx * dx + dy * dy + dz * dz];
      }),
    };
    const rx = Math.hypot(canopy.rx * cosine, canopy.rz * sine),
      rz = Math.hypot(canopy.rx * sine, canopy.rz * cosine);
    if ((rx / cellSize + 2) * (rz / cellSize + 2) > 64) {
      globalCanopies.push(crown);
      continue;
    }
    for (
      let z = Math.floor((canopy.z - rz) / cellSize);
      z <= Math.floor((canopy.z + rz) / cellSize);
      z++
    )
      for (
        let x = Math.floor((canopy.x - rx) / cellSize);
        x <= Math.floor((canopy.x + rx) / cellSize);
        x++
      ) {
        const key = x + ',' + z,
          bin = bins.get(key) ?? [];
        bin.push(crown);
        bins.set(key, bin);
      }
  }
  for (let z = 0; z < cells; z++)
    for (let x = 0; x < cells; x++) {
      const px = minimum[0] + ((x + 0.5) / cells) * p.size,
        pz = minimum[2] + ((z + 0.5) / cells) * p.size;
      const ground = heightAt(p, px, pz),
        weights = materialWeights(p, px, pz);
      groundPixels[z * cells + x] = (ground - minY) / groundRange[1];
      const color = [0, 0, 0];
      input.colors.forEach((tint, index) => {
        for (let channel = 0; channel < 3; channel++)
          color[channel] += tint[channel] * weights[index];
      });
      const candidates = new Set<Crown>(globalCanopies);
      for (
        let bz = Math.floor((pz - reach) / cellSize);
        bz <= Math.floor((pz + reach) / cellSize);
        bz++
      )
        for (
          let bx = Math.floor((px - reach) / cellSize);
          bx <= Math.floor((px + reach) / cellSize);
          bx++
        )
          for (const canopy of bins.get(bx + ',' + bz) ?? [])
            candidates.add(canopy);
      for (let y = 0; y < 8; y++) {
        const py = ground + minimum[1] + ((y + 0.5) / 8) * size[1];
        depths.fill(0);
        for (const canopy of candidates) {
          const ox =
              ((px - canopy.x) * canopy.cosine -
                (pz - canopy.z) * canopy.sine) /
              canopy.rx,
            oy = (py - canopy.y) / canopy.ry,
            oz =
              ((px - canopy.x) * canopy.sine +
                (pz - canopy.z) * canopy.cosine) /
              canopy.rz,
            c = ox * ox + oy * oy + oz * oz - 1;
          for (let index = 0; index < rays.length; index++) {
            if (depths[index] > 6) continue;
            const [dx, dy, dz, a] = canopy.directions[index],
              b = ox * dx + oy * dy + oz * dz,
              discriminant = b * b - a * c;
            if (discriminant <= 0) continue;
            const root = Math.sqrt(discriminant),
              near = Math.max(0, (-b - root) / a),
              far = Math.min(reach, (-b + root) / a);
            if (far > near) depths[index] += (far - near) * canopy.density;
          }
        }
        let visibility = 0;
        for (const depth of depths)
          visibility += Math.exp(-depth) / rays.length;
        const offset = ((z * 8 + y) * cells + x) * 4;
        const bounce =
          Math.exp(-Math.max(0, py - ground) / 10) * (0.15 + 0.85 * visibility);
        for (let channel = 0; channel < 3; channel++)
          pixels[offset + channel] = Math.max(
            0,
            Math.min(1, color[channel] * bounce),
          );
        pixels[offset + 3] = visibility;
      }
    }
  return {
    pixels,
    dimensions,
    minimum,
    size,
    ground: groundPixels,
    groundRange,
  };
}
