import type { FoliageBrush, FoliageInstance, FoliageModel } from './types';

/** Resolve old single-model brushes without mutating a saved document. */
export function foliageModels(brush: FoliageBrush): FoliageModel[] {
  return (
    brush.models ?? [
      {
        id: 'primary',
        model: brush.model,
        weight: 1,
        minScale: brush.minScale,
        maxScale: brush.maxScale,
        minRotation: -brush.rotation,
        maxRotation: brush.rotation,
        alignToNormal: brush.alignToNormal,
        wind: brush.wind,
        crush: brush.crush,
        color: brush.color,
      },
    ]
  );
}

export function foliageModel(brush: FoliageBrush, instance: FoliageInstance) {
  const models = foliageModels(brush);
  return instance.modelId === undefined
    ? models[0]
    : models.find((model) => model.id === instance.modelId);
}

/** Convert a legacy brush and its instances to an editable mixture. */
export function editFoliageModels(
  brush: FoliageBrush,
  instances: FoliageInstance[],
) {
  if (!brush.models) {
    brush.models = foliageModels(brush);
    for (const instance of instances)
      if (instance.brushId === brush.id && instance.modelId === undefined)
        instance.modelId = brush.models[0].id;
  }
  return brush.models;
}

/** Shared spatial index for all stamps/tiles in one scatter operation. */
export class FoliageSpacing {
  private cells = new Map<string, FoliageInstance[]>();
  constructor(
    private distance: number,
    instances: FoliageInstance[],
  ) {
    if (distance > 0) for (const instance of instances) this.add(instance);
  }
  private key(x: number, z: number) {
    return Math.floor(x / this.distance) + ',' + Math.floor(z / this.distance);
  }
  add(instance: FoliageInstance) {
    if (this.distance <= 0) return;
    const key = this.key(instance.x, instance.z);
    const cell = this.cells.get(key) ?? [];
    cell.push(instance);
    this.cells.set(key, cell);
  }
  allows(x: number, z: number) {
    if (this.distance <= 0) return true;
    const cx = Math.floor(x / this.distance),
      cz = Math.floor(z / this.distance);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const instance of this.cells.get(cx + dx + ',' + (cz + dz)) ?? [])
          if (Math.hypot(x - instance.x, z - instance.z) < this.distance)
            return false;
    return true;
  }
}
