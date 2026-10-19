import { clamp } from './math';
import type { FoliageInstance, TerrainProject } from './types';

/** Engine-independent influence emitted where an object contacts the ground. */
export interface GroundContact {
  x: number;
  z: number;
  radius: number;
  strength: number;
}

/** Sparse contact response: only nearby and recovering instances require work. */
export class FoliageInteraction {
  private cells = new Map<string, FoliageInstance[]>();
  private amounts = new Map<number, number>();
  private validIds = new Set<number>();
  constructor(private cellSize = 8) {}
  setInstances(instances: FoliageInstance[]) {
    this.cells.clear();
    this.validIds = new Set(instances.map((f) => f.id));
    for (const f of instances) {
      const key = this.key(f.x, f.z);
      const cell = this.cells.get(key) ?? [];
      cell.push(f);
      this.cells.set(key, cell);
    }
    for (const id of this.amounts.keys())
      if (!this.validIds.has(id)) this.amounts.delete(id);
  }
  /** Independent spatial index and recovery state for a candidate population. */
  fork(instances: FoliageInstance[]) {
    const result = new FoliageInteraction(this.cellSize);
    result.amounts = new Map(this.amounts);
    result.setInstances(instances);
    return result;
  }
  private key(x: number, z: number) {
    return Math.floor(x / this.cellSize) + ',' + Math.floor(z / this.cellSize);
  }
  amount(id: number) {
    return this.amounts.get(id) ?? 0;
  }
  clear() {
    const changed = new Set(this.amounts.keys());
    this.amounts.clear();
    return changed;
  }
  /** Optional per-instance settings override the legacy defaults and contact radius.
   * maximumRadius must cover every enabled override so the spatial query includes it. */
  update(
    dt: number,
    contacts: GroundContact[],
    settings: TerrainProject['interaction'],
    resolve?: (id: number) => TerrainProject['interaction'] | undefined,
    maximumRadius = 0,
  ) {
    const changed = new Set<number>();
    if (!settings.enabled && maximumRadius === 0) return this.clear();
    for (const [id, amount] of this.amounts) {
      const selected = resolve?.(id) ?? settings;
      const next = selected.enabled
        ? amount *
          Math.exp(-Math.max(0, dt) / Math.max(0.01, selected.recovery))
        : 0;
      changed.add(id);
      if (next < 0.001) this.amounts.delete(id);
      else this.amounts.set(id, next);
    }
    for (const contact of contacts) {
      const radius = Math.max(0.01, contact.radius, maximumRadius),
        minX = Math.floor((contact.x - radius) / this.cellSize),
        maxX = Math.floor((contact.x + radius) / this.cellSize),
        minZ = Math.floor((contact.z - radius) / this.cellSize),
        maxZ = Math.floor((contact.z + radius) / this.cellSize);
      for (let z = minZ; z <= maxZ; z++)
        for (let x = minX; x <= maxX; x++)
          for (const f of this.cells.get(x + ',' + z) ?? []) {
            const override = resolve?.(f.id);
            const selected = override ?? settings;
            if (!selected.enabled) continue;
            const reach = Math.max(0.01, override?.radius ?? contact.radius);
            const amount = clamp(
              (1 - Math.hypot(f.x - contact.x, f.z - contact.z) / reach) *
                contact.strength *
                selected.strength,
            );
            if (amount > this.amount(f.id)) {
              this.amounts.set(f.id, amount);
              changed.add(f.id);
            }
          }
    }
    return changed;
  }
}
