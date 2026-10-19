import type { TerrainProject } from './types';
import { parseWaterSettings } from './water';

/** Camera height above the terrain in metres, including for older projects. */
export const DEFAULT_EYE_HEIGHT = 1.8;

export function parseEyeHeight(value: unknown = DEFAULT_EYE_HEIGHT): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0.1 ||
    value > 100
  )
    throw new Error('First-person eye height must be 0.1–100 metres.');
  return value;
}

/**
 * Prepare a resized square terrain without changing the source or cell count.
 * Size is the side length in metres. Elevation and water level scale by default.
 * Plants and props retain their dimensions and relative horizontal locations;
 * material rules, texture repeats and other settings remain in world metres.
 * Unchanged buffers and metadata are shared until the candidate is committed.
 */
export function resizeTerrain(
  project: TerrainProject,
  size: number,
  scaleElevation = true,
): TerrainProject {
  if (!Number.isFinite(size) || size < 8 || size > 10000)
    throw new Error('Terrain size must be 8–10000 metres.');
  const factor = size / project.size;
  const heights = scaleElevation
    ? project.heights.map((height) => height * factor)
    : project.heights;
  if (
    heights.some(
      (height) => !Number.isFinite(height) || Math.abs(height) > size,
    )
  )
    throw new Error(
      'Elevation exceeds the new terrain size. Enable elevation scaling or choose a larger size.',
    );
  const waterLevel =
    (project.water?.seaLevel ?? project.view.waterLevel) *
    (scaleElevation ? factor : 1);
  if (!Number.isFinite(waterLevel) || Math.abs(waterLevel) > 10000)
    throw new Error(
      'The scaled water level exceeds 10000 metres. Lower it before resizing.',
    );
  return {
    ...project,
    size,
    heights,
    view: { ...project.view, waterLevel },
    ...(project.water
      ? {
          water: parseWaterSettings({
            ...project.water,
            seaLevel: project.water.seaLevel * (scaleElevation ? factor : 1),
            bodies: project.water.bodies.map((body) => ({
              ...body,
              elevation: body.elevation * (scaleElevation ? factor : 1),
              extent:
                body.extent.kind === 'polygon'
                  ? {
                      ...body.extent,
                      points: body.extent.points.map((p) => ({
                        x: p.x * factor,
                        z: p.z * factor,
                      })),
                    }
                  : {
                      ...body.extent,
                      x: body.extent.x * factor,
                      z: body.extent.z * factor,
                      ...(body.extent.kind === 'ellipse'
                        ? {
                            radiusX: body.extent.radiusX * factor,
                            radiusZ: body.extent.radiusZ * factor,
                          }
                        : {}),
                    },
            })),
          }),
        }
      : {}),
    foliage: project.foliage.map((plant) => ({
      ...plant,
      x: plant.x * factor,
      z: plant.z * factor,
    })),
    props: project.props.map((prop) => ({
      ...prop,
      x: prop.x * factor,
      z: prop.z * factor,
    })),
  };
}
