export interface StrokePoint {
  x: number;
  y: number;
  z: number;
}
export interface StrokeDab {
  point: StrokePoint;
  first: boolean;
  dose: number;
}
/** Fixed-time dabs with spatial interpolation. Time and spacing use seconds/metres. */
export class StrokeSampler {
  private previous?: { point: StrokePoint; pressure: number; time: number };
  private lastDab?: StrokePoint;
  private nextTime = 0;
  private stamped = false;
  constructor(readonly interval = 0.06) {
    if (!Number.isFinite(interval) || interval <= 0)
      throw new Error('Invalid stroke interval.');
  }
  reset() {
    this.previous = undefined;
    this.lastDab = undefined;
    this.stamped = false;
    this.nextTime = 0;
  }
  sample(
    point: StrokePoint | null,
    time: number,
    pressure: number,
    spacing: number,
    once = false,
  ): StrokeDab[] {
    if (
      !Number.isFinite(time) ||
      !Number.isFinite(pressure) ||
      !Number.isFinite(spacing) ||
      spacing <= 0
    )
      throw new Error('Invalid stroke input.');
    pressure = Math.max(0, Math.min(1, pressure));
    if (!point || pressure <= 0) {
      this.previous = undefined;
      this.lastDab = undefined;
      return [];
    }
    if (once && this.stamped) return [];
    const result: StrokeDab[] = [];
    const current = { point: { ...point }, pressure, time };
    if (!this.previous) {
      result.push({
        point: { ...point },
        first: !this.stamped,
        dose: pressure,
      });
      this.stamped = true;
      this.lastDab = { ...point };
      this.nextTime = time + this.interval;
    } else {
      const previous = this.previous;
      if (time < previous.time)
        throw new Error('Stroke time must be monotonic.');
      // A suspended tab must not queue unbounded editing work on return.
      if (time - previous.time > 0.5) this.nextTime = time;
      while (this.nextTime <= time + 1e-9) {
        const t =
          time === previous.time
            ? 1
            : Math.max(
                0,
                Math.min(
                  1,
                  (this.nextTime - previous.time) / (time - previous.time),
                ),
              );
        const destination = {
          x: previous.point.x + (point.x - previous.point.x) * t,
          y: previous.point.y + (point.y - previous.point.y) * t,
          z: previous.point.z + (point.z - previous.point.z) * t,
        };
        const from = this.lastDab ?? destination;
        const steps = Math.min(
          64,
          Math.max(
            1,
            Math.ceil(
              Math.hypot(destination.x - from.x, destination.z - from.z) /
                spacing,
            ),
          ),
        );
        const dose =
          (previous.pressure + (pressure - previous.pressure) * t) / steps;
        for (let i = 1; i <= steps; i++)
          result.push({
            point: {
              x: from.x + ((destination.x - from.x) * i) / steps,
              y: from.y + ((destination.y - from.y) * i) / steps,
              z: from.z + ((destination.z - from.z) * i) / steps,
            },
            first: false,
            dose,
          });
        this.lastDab = destination;
        this.nextTime += this.interval;
      }
    }
    this.previous = current;
    return result;
  }
}
