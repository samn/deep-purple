/**
 * The temperature + dew point forecast at one location, as a full series over
 * lead time.
 *
 * The time-optimized store returns every lead in a single read, so there is no
 * sparse cache or progressive refinement to manage here: either the series is
 * loaded and every hour is exact, or nothing is. `reading` interpolates between
 * adjacent leads so the values track a fractional timeline position smoothly.
 */

export interface PointReading {
  /** 2 m air temperature, °C. */
  temperatureC: number;
  /** 2 m dew point temperature, °C. */
  dewpointC: number;
}

export class PointSeries {
  private hours: number[] = [];
  private temps: Float32Array | null = null;
  private dews: Float32Array | null = null;

  get loaded(): boolean {
    return this.temps !== null;
  }

  setSeries(leadHours: number[], temperatureC: Float32Array, dewpointC: Float32Array): void {
    this.hours = leadHours;
    this.temps = temperatureC;
    this.dews = dewpointC;
  }

  clear(): void {
    this.hours = [];
    this.temps = null;
    this.dews = null;
  }

  /**
   * Reading at time `t` (hours), linearly interpolated between the bracketing
   * leads and clamped to the ends of the series. Null until loaded, or if the
   * bracketing values are non-finite (a masked cell).
   */
  reading(t: number): PointReading | null {
    const { hours, temps, dews } = this;
    if (!temps || !dews || hours.length === 0) return null;

    let below = 0;
    for (let i = 0; i < hours.length; i++) {
      if (hours[i]! <= t) below = i;
    }
    let above = below;
    for (let i = below; i < hours.length; i++) {
      if (hours[i]! >= t) {
        above = i;
        break;
      }
    }

    const ta = temps[below];
    const tb = temps[above];
    const da = dews[below];
    const db = dews[above];
    if (ta === undefined || tb === undefined || da === undefined || db === undefined) return null;
    if (!Number.isFinite(ta) || !Number.isFinite(tb) || !Number.isFinite(da) || !Number.isFinite(db)) {
      return null;
    }

    const ha = hours[below]!;
    const hb = hours[above]!;
    const f = hb > ha ? Math.max(0, Math.min(1, (t - ha) / (hb - ha))) : 0;
    return {
      temperatureC: ta + (tb - ta) * f,
      dewpointC: da + (db - da) * f,
    };
  }
}
