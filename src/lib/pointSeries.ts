/**
 * Cache of single-cell temperature + dew point readings at one location,
 * keyed by lead index.
 *
 * Samples are fetched on demand (one whole-grid chunk per lead per variable),
 * so the cache is always sparse. Display and fetching therefore use different
 * lookups, mirroring how FrameStore handles progressively loading frames:
 * `bracket` names the exact leads worth fetching for a time, while `reading`
 * interpolates between the nearest leads actually cached — so scrubbing shows
 * a slightly stale value that sharpens when the sample lands, instead of
 * blanking out on every move.
 */
import { READOUT_LEAD_STRIDE_HOURS } from "../config.ts";

export interface PointReading {
  /** 2 m air temperature, °C. */
  temperatureC: number;
  /** 2 m dew point temperature, °C. */
  dewpointC: number;
}

export class PointSeries {
  private readonly cache = new Map<number, PointReading>();
  readonly leadHours: number[];
  /** Lead indices eligible for sampling: stride-aligned, plus the last lead. */
  readonly sampleable: number[];

  constructor(leadHours: number[], strideHours = READOUT_LEAD_STRIDE_HOURS) {
    this.leadHours = leadHours;
    const stride = Math.max(1, strideHours);
    const sampleable: number[] = [];
    for (let i = 0; i < leadHours.length; i++) {
      if (leadHours[i]! % stride === 0) sampleable.push(i);
    }
    const last = leadHours.length - 1;
    if (last >= 0 && sampleable[sampleable.length - 1] !== last) sampleable.push(last);
    this.sampleable = sampleable;
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
   * Sampleable lead indices bracketing time `t` (hours): `[below, above]`,
   * where both sides are drawn from the stride-aligned subset (see
   * READOUT_LEAD_STRIDE_HOURS) rather than every hourly lead. This is the
   * fetch target, so restricting it here is what bounds the readout's data
   * cost. Both entries are equal when `t` lands on a sampleable lead or falls
   * outside their span.
   */
  bracket(t: number): [below: number, above: number] {
    const sampleable = this.sampleable;
    if (sampleable.length === 0) return [0, 0];
    const hours = this.leadHours;
    let below = sampleable[0]!;
    for (const i of sampleable) {
      if (hours[i]! <= t) below = i;
    }
    let above = sampleable[sampleable.length - 1]!;
    for (let k = sampleable.length - 1; k >= 0; k--) {
      const i = sampleable[k]!;
      if (hours[i]! >= t) above = i;
    }
    if (hours[above]! < hours[below]!) above = below;
    return [below, above];
  }

  /**
   * Interpolated reading at time `t` from the nearest cached leads on either
   * side, or the single nearest cached lead when `t` is outside their span.
   * Null only while nothing at all is cached.
   */
  reading(t: number): PointReading | null {
    const hours = this.leadHours;
    let below = -1;
    let above = -1;
    for (const leadIndex of this.cache.keys()) {
      const h = hours[leadIndex];
      if (h === undefined) continue;
      if (h <= t && (below === -1 || h > hours[below]!)) below = leadIndex;
      if (h >= t && (above === -1 || h < hours[above]!)) above = leadIndex;
    }
    if (below === -1 && above === -1) return null;
    if (below === -1 || above === -1 || below === above) {
      const r = this.cache.get(below === -1 ? above : below)!;
      return { temperatureC: r.temperatureC, dewpointC: r.dewpointC };
    }
    const ra = this.cache.get(below)!;
    const rb = this.cache.get(above)!;
    const ha = hours[below]!;
    const hb = hours[above]!;
    const f = hb > ha ? Math.max(0, Math.min(1, (t - ha) / (hb - ha))) : 0;
    return {
      temperatureC: ra.temperatureC + (rb.temperatureC - ra.temperatureC) * f,
      dewpointC: ra.dewpointC + (rb.dewpointC - ra.dewpointC) * f,
    };
  }
}
