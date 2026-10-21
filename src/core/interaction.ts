import { clamp } from './math';
import type { FoliageInstance, TerrainProject } from './types';

/** Engine-independent influence emitted where an object contacts the ground. */
export interface GroundContact {
  x: number;
  z: number;
  radius: number;
  strength: number;
  /** Optional upright capsule in terrain-local metres. bottom/top include the rounded ends. */
  capsule?: { bottom: number; top: number };
}
export interface FoliageContactBounds {
  radius: number;
  minY: number;
  maxY: number;
}

/** Sparse contact response: only nearby and recovering instances require work. */
export class FoliageInteraction {
  private cells = new Map<string, FoliageInstance[]>();
  private amounts = new Map<number, number>();
  private capsules = new Map<number, GroundContact>();
  private capsuleWeights = new Map<number, number>();
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
      if (!this.validIds.has(id)) {
        this.amounts.delete(id);
        this.capsules.delete(id);
        this.capsuleWeights.delete(id);
      }
  }
  /** Independent spatial index and recovery state for a candidate population. */
  fork(instances: FoliageInstance[]) {
    const result = new FoliageInteraction(this.cellSize);
    result.amounts = new Map(this.amounts);
    result.capsules = new Map(this.capsules);
    result.capsuleWeights = new Map(this.capsuleWeights);
    result.setInstances(instances);
    return result;
  }
  private key(x: number, z: number) {
    return Math.floor(x / this.cellSize) + ',' + Math.floor(z / this.cellSize);
  }
  amount(id: number) {
    return this.amounts.get(id) ?? 0;
  }
  capsule(id: number) {
    return this.capsules.get(id);
  }
  clear() {
    const changed = new Set(this.amounts.keys());
    this.amounts.clear();
    this.capsules.clear();
    this.capsuleWeights.clear();
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
    bounds?: (id: number) => FoliageContactBounds | undefined,
    maximumPlantRadius = 0,
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
      const weight = this.capsuleWeights.get(id);
      if (weight !== undefined)
        this.capsuleWeights.set(id, weight * (amount > 0 ? next / amount : 0));
      if (next < 0.001) {
        this.amounts.delete(id);
        this.capsules.delete(id);
        this.capsuleWeights.delete(id);
      } else this.amounts.set(id, next);
    }
    for (const contact of contacts) {
      if (
        !Number.isFinite(
          contact.x + contact.z + contact.radius + contact.strength,
        ) ||
        contact.radius <= 0
      )
        continue;
      if (
        contact.capsule &&
        (!Number.isFinite(contact.capsule.bottom + contact.capsule.top) ||
          contact.capsule.top < contact.capsule.bottom + contact.radius * 2)
      )
        continue;
      const radius = contact.capsule
          ? contact.radius + 0.2 + maximumPlantRadius
          : Math.max(0.01, contact.radius, maximumRadius),
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
            if (contact.capsule) {
              const shape = bounds?.(f.id);
              if (
                !shape ||
                shape.maxY < contact.capsule.bottom - 0.2 ||
                shape.minY > contact.capsule.top + 0.2 ||
                Math.hypot(f.x - contact.x, f.z - contact.z) >
                  shape.radius + contact.radius + 0.2
              )
                continue;
              const amount = clamp(contact.strength * selected.strength);
              if (amount <= 0) continue;
              // Retain the closest imprint as the body leaves. Replacing it
              // with an empty, receding capsule would erase a trampled trail.
              const weight =
                amount / (1 + Math.hypot(f.x - contact.x, f.z - contact.z));
              if (weight < (this.capsuleWeights.get(f.id) ?? 0)) continue;
              this.capsuleWeights.set(f.id, weight);
              this.amounts.set(f.id, Math.max(amount, this.amount(f.id)));
              // Own the pose: callers commonly reuse their contact objects next frame.
              this.capsules.set(f.id, {
                ...contact,
                capsule: { ...contact.capsule },
              });
              changed.add(f.id);
              continue;
            }
            const reach = Math.max(0.01, override?.radius ?? contact.radius);
            const amount = clamp(
              (1 - Math.hypot(f.x - contact.x, f.z - contact.z) / reach) *
                contact.strength *
                selected.strength,
            );
            if (amount > this.amount(f.id)) {
              this.amounts.set(f.id, amount);
              this.capsules.delete(f.id);
              this.capsuleWeights.delete(f.id);
              changed.add(f.id);
            }
          }
    }
    return changed;
  }
}
