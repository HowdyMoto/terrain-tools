import type { FoliageModel } from './types';

/** Validate optional detail settings; the document also checks model references. */
export function validateFoliageDetail(
  model: Pick<
    FoliageModel,
    'lods' | 'cullDistance' | 'lodHysteresis' | 'lodFadeDuration'
  >,
) {
  if (
    model.lodFadeDuration !== undefined &&
    (!Number.isFinite(model.lodFadeDuration) ||
      model.lodFadeDuration < 0 ||
      model.lodFadeDuration > 5)
  )
    throw new Error('LOD transition time must be from 0 to 5 seconds.');
  const lods = model.lods;
  if (lods !== undefined && (!Array.isArray(lods) || lods.length > 3))
    throw new Error('Use at most three foliage LODs.');
  let distance = 0,
    density = 1;
  for (const lod of lods ?? []) {
    if (!lod || typeof lod.model !== 'string')
      throw new Error('Invalid LOD model.');
    if (
      !Number.isFinite(lod.distance) ||
      lod.distance < 0.1 ||
      lod.distance > 100000 ||
      lod.distance <= distance
    )
      throw new Error('LOD distances must increase, from 0.1 to 100,000 m.');
    if (
      !Number.isFinite(lod.density) ||
      lod.density < 0 ||
      lod.density > density
    )
      throw new Error(
        'LOD density must stay the same or decrease, from 0 to 100%.',
      );
    distance = lod.distance;
    density = lod.density;
  }
  if (
    model.cullDistance !== undefined &&
    (!Number.isFinite(model.cullDistance) ||
      model.cullDistance < 0 ||
      model.cullDistance > 100000 ||
      (model.cullDistance !== 0 && model.cullDistance <= distance))
  )
    throw new Error(
      'Cull distance must be 0 (unlimited) or greater than every LOD distance, up to 100,000 m.',
    );
  if (
    model.lodHysteresis !== undefined &&
    (!Number.isFinite(model.lodHysteresis) ||
      model.lodHysteresis < 0 ||
      model.lodHysteresis > 0.5)
  )
    throw new Error('LOD hysteresis must be from 0 to 50%.');
}

/** Stable probability for thinning the same instances at every distance and reload. */
export function foliageDensityRank(id: number) {
  let value = (id >>> 0) ^ (Math.floor(id / 4294967296) >>> 0);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

/**
 * 0 is the primary mesh; 1..N are authored LODs; N+1 means distance-culled.
 * Distances are terrain-local metres. A previous level of -1 selects immediately.
 */
export function foliageDistanceLevel(
  model: FoliageModel,
  distance: number,
  previous = -1,
) {
  const lods = model.lods,
    count = lods?.length ?? 0,
    far = model.cullDistance || Infinity;
  let level = previous < 0 ? 0 : Math.min(previous, count + 1);
  const hysteresis = previous < 0 ? 0 : (model.lodHysteresis ?? 0.1);
  while (
    level <= count &&
    distance >= (level < count ? lods![level].distance : far) * (1 + hysteresis)
  )
    level++;
  while (
    level > 0 &&
    distance <
      (level <= count ? lods![level - 1].distance : far) * (1 - hysteresis)
  )
    level--;
  return level;
}

/**
 * Time-based LOD coverage, independent of a renderer. Visible levels share [0,1);
 * the remaining interval is hidden. Retargeting samples the current blend first.
 */
export class FoliageLodTransitions {
  readonly targets: Int8Array;
  readonly weights: Float32Array;
  private readonly origins: Float32Array;
  private readonly starts: Float64Array;
  private readonly active = new Set<number>();
  private lastUpdate = -Infinity;
  constructor(
    readonly count: number,
    readonly levels: number,
    readonly duration: number,
  ) {
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > 50000 ||
      !Number.isInteger(levels) ||
      levels < 1 ||
      levels > 4 ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > 5
    )
      throw new Error(
        'Invalid foliage transition capacity, levels, or duration.',
      );
    this.targets = new Int8Array(count);
    this.weights = new Float32Array(count * levels);
    this.origins = new Float32Array(count * levels);
    this.starts = new Float64Array(count);
    this.reset();
  }
  get activeCount() {
    return this.active.size;
  }
  reset() {
    this.targets.fill(0);
    this.weights.fill(0);
    for (let index = 0; index < this.count; index++)
      this.weights[index * this.levels] = 1;
    this.active.clear();
    this.lastUpdate = -Infinity;
  }
  /** target -1 means hidden (distance culling or density thinning). */
  setTarget(index: number, target: number, time: number, immediate = false) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.count ||
      !Number.isInteger(target) ||
      target < -1 ||
      target >= this.levels ||
      !Number.isFinite(time)
    )
      throw new Error('Invalid foliage transition target or time.');
    if (!immediate && this.targets[index] === target) return false;
    if (this.active.has(index)) this.sample(index, time);
    this.targets[index] = target;
    const offset = index * this.levels;
    let settled = true;
    for (let level = 0; level < this.levels; level++)
      if (this.weights[offset + level] !== (level === target ? 1 : 0))
        settled = false;
    if (immediate || this.duration === 0 || settled) {
      for (let level = 0; level < this.levels; level++)
        this.weights[offset + level] = level === target ? 1 : 0;
      this.active.delete(index);
    } else {
      this.origins.set(
        this.weights.subarray(offset, offset + this.levels),
        offset,
      );
      this.starts[index] = time;
      this.active.add(index);
    }
    return true;
  }
  /** Advance only moving instances. A finished transition may release old draw slots. */
  advance(time: number, changed: (index: number, finished: boolean) => void) {
    if (!Number.isFinite(time))
      throw new Error('Invalid foliage transition time.');
    if (time === this.lastUpdate) return;
    this.lastUpdate = time;
    for (const index of this.active) changed(index, this.sample(index, time));
  }
  private sample(index: number, time: number) {
    const t = Math.min(
      1,
      Math.max(0, (time - this.starts[index]) / this.duration),
    );
    const offset = index * this.levels,
      target = this.targets[index];
    for (let level = 0; level < this.levels; level++) {
      const origin = this.origins[offset + level];
      this.weights[offset + level] =
        t === 1
          ? level === target
            ? 1
            : 0
          : origin * (1 - t) + (level === target ? t : 0);
    }
    if (t === 1) this.active.delete(index);
    return t === 1;
  }
  includes(index: number, level: number) {
    return (
      this.weights[index * this.levels + level] > 0 ||
      this.targets[index] === level
    );
  }
  /** Write complementary coverage bounds into an existing GPU/data buffer. */
  writeRange(
    index: number,
    level: number,
    output: { [index: number]: number },
    offset = 0,
  ) {
    const start = index * this.levels;
    let lower = 0;
    for (let previous = 0; previous < level; previous++)
      lower += this.weights[start + previous];
    output[offset] = Math.min(1, lower);
    output[offset + 1] = Math.min(1, lower + this.weights[start + level]);
  }
}
