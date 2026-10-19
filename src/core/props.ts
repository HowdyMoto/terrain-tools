import type { PropCutout, PropInstance, TerrainRegion } from './types';

/** Reject invalid authored footprints before they reach rendering or collision. */
export function validatePropCutout(
  value: unknown,
): asserts value is PropCutout {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid prop cutout.');
  const c = value as Record<string, unknown>;
  if (c.shape !== 'rectangle') throw new Error('Unknown prop cutout shape.');
  for (const key of ['width', 'depth', 'offsetX', 'offsetZ'] as const) {
    const v = c[key],
      dimension = key === 'width' || key === 'depth';
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < (dimension ? 0.01 : -10000) ||
      v > (dimension ? 20000 : 10000)
    )
      throw new Error('Invalid prop cutout ' + key + '.');
  }
}

/** Snapshot model-local projected bounds; no runtime model decoding is needed for holes. */
export function fitPropCutout(
  bounds: TerrainRegion,
  minimumExtent = 0.01,
): PropCutout {
  if (
    ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, minimumExtent].every(
      Number.isFinite,
    ) ||
    bounds.minX > bounds.maxX ||
    bounds.minZ > bounds.maxZ ||
    minimumExtent < 0.01 ||
    minimumExtent > 20000
  )
    throw new Error('Invalid projected model bounds.');
  const cutout: PropCutout = {
    shape: 'rectangle',
    width: Math.max(minimumExtent, bounds.maxX - bounds.minX),
    depth: Math.max(minimumExtent, bounds.maxZ - bounds.minZ),
    offsetX: (bounds.minX + bounds.maxX) / 2,
    offsetZ: (bounds.minZ + bounds.maxZ) / 2,
  };
  validatePropCutout(cutout);
  return cutout;
}

/** Precompute the footprint once, then test terrain cell centres in its local frame. */
export function propFootprint(prop: PropInstance) {
  const c = Math.cos(prop.rotation),
    s = Math.sin(prop.rotation),
    scale = prop.scale;
  const rectangle = prop.cutout;
  const offsetX = rectangle?.offsetX ?? 0,
    offsetZ = rectangle?.offsetZ ?? 0;
  const x = prop.x + scale * (c * offsetX + s * offsetZ),
    z = prop.z + scale * (-s * offsetX + c * offsetZ);
  const halfX = scale * (rectangle ? rectangle.width / 2 : prop.holeRadius),
    halfZ = scale * (rectangle ? rectangle.depth / 2 : prop.holeRadius);
  const radiusX = rectangle ? Math.abs(c) * halfX + Math.abs(s) * halfZ : halfX;
  const radiusZ = rectangle ? Math.abs(s) * halfX + Math.abs(c) * halfZ : halfZ;
  return {
    bounds: {
      minX: x - radiusX,
      maxX: x + radiusX,
      minZ: z - radiusZ,
      maxZ: z + radiusZ,
    },
    contains(px: number, pz: number) {
      const dx = px - x,
        dz = pz - z;
      return rectangle
        ? Math.abs(c * dx - s * dz) <= halfX + 1e-9 &&
            Math.abs(s * dx + c * dz) <= halfZ + 1e-9
        : Math.hypot(dx, dz) <= halfX;
    },
    /** Ground-plane outline; callers can sample terrain height for display. */
    outline(segments = 64) {
      const points: { x: number; z: number }[] = [];
      for (let i = 0; i < segments; i++) {
        let lx: number, lz: number;
        if (rectangle) {
          const side = (i * 4) / segments,
            t = side % 1;
          if (side < 1) {
            lx = -halfX + 2 * halfX * t;
            lz = -halfZ;
          } else if (side < 2) {
            lx = halfX;
            lz = -halfZ + 2 * halfZ * t;
          } else if (side < 3) {
            lx = halfX - 2 * halfX * t;
            lz = halfZ;
          } else {
            lx = -halfX;
            lz = halfZ - 2 * halfZ * t;
          }
        } else {
          const angle = (i / segments) * Math.PI * 2;
          lx = Math.cos(angle) * halfX;
          lz = Math.sin(angle) * halfZ;
        }
        points.push({ x: x + c * lx + s * lz, z: z - s * lx + c * lz });
      }
      return points;
    },
  };
}
