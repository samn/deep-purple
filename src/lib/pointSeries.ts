/**
 * Cache of single-cell temperature + dew point readings at one location,
 * keyed by lead index, with bracketing and linear interpolation over the
 * fixed lead-hour grid so the readout can track a fractional timeline
 * position while values are still streaming in.
 */

export interface PointReading {
  /** 2 m air temperature, °C. */
  temperatureC: number;
  /** 2 m dew point temperature, °C. */
  dewpointC: number;
}

export class PointSeries {
  private readonly cache = new Map<number, PointReading>();
  readonly leadHours: number[];

  constructor(leadHours: number[]) {
    this.leadHours = leadHours;
  }

  clear(): void {
    this.cache.clear();
  }

  has(leadIndex: number): boolean {
    return this.cache.has(leadIndex);
  }

  set(leadIndex: number, reading: PointReading): void {
    this.cache.set(leadIndex, reading);
  }

  /**
   * Lead indices bracketing time `t` (hours): `[below, above]`, where
   * `hours[below] <= t <= hours[above]`. Both equal `t` lands on a lead or
   * falls outside the range.
   */
  bracket(t: number): [below: number, above: number] {
    const hours = this.leadHours;
    if (hours.length === 0) return [0, 0];
    let below = 0;
    for (let i = 0; i < hours.length; i++) {
      if (hours[i]! <= t) below = i;
    }
    let above = hours.length - 1;
    for (let i = hours.length - 1; i >= 0; i--) {
      if (hours[i]! >= t) above = i;
    }
    if (above < below) above = below;
    return [below, above];
  }

  /**
   * Interpolated reading at time `t`. Uses both bracketing leads when cached,
   * otherwise whichever side is available, and null when neither is yet loaded.
   */
  reading(t: number): PointReading | null {
    const [a, b] = this.bracket(t);
    const ra = this.cache.get(a) ?? null;
    const rb = this.cache.get(b) ?? null;
    if (!ra && !rb) return null;
    if (a === b || !ra || !rb) {
      const r = ra ?? rb!;
      return { temperatureC: r.temperatureC, dewpointC: r.dewpointC };
    }
    const ha = this.leadHours[a]!;
    const hb = this.leadHours[b]!;
    const f = hb > ha ? Math.max(0, Math.min(1, (t - ha) / (hb - ha))) : 0;
    return {
      temperatureC: ra.temperatureC + (rb.temperatureC - ra.temperatureC) * f,
      dewpointC: ra.dewpointC + (rb.dewpointC - ra.dewpointC) * f,
    };
  }
}
