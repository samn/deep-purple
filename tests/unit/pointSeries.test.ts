import { describe, expect, it } from "vitest";
import { PointSeries } from "../../src/lib/pointSeries.ts";

const HOURS = Array.from({ length: 49 }, (_, i) => i);
/** Ramp so an interpolated value is easy to predict: value == lead hour. */
const ramp = (offset = 0) => Float32Array.from(HOURS, (h) => h + offset);

describe("PointSeries", () => {
  it("reads nothing until a series is loaded", () => {
    const ps = new PointSeries();
    expect(ps.loaded).toBe(false);
    expect(ps.reading(0)).toBeNull();
    expect(ps.reading(12.5)).toBeNull();
  });

  it("returns the exact value on a lead", () => {
    const ps = new PointSeries();
    ps.setSeries(HOURS, ramp(), ramp(-10));
    expect(ps.loaded).toBe(true);
    expect(ps.reading(12)).toEqual({ temperatureC: 12, dewpointC: 2 });
  });

  it("interpolates between adjacent leads", () => {
    const ps = new PointSeries();
    ps.setSeries(HOURS, ramp(), ramp(-10));
    const r = ps.reading(12.25)!;
    expect(r.temperatureC).toBeCloseTo(12.25);
    expect(r.dewpointC).toBeCloseTo(2.25);
  });

  it("clamps outside the series instead of extrapolating", () => {
    const ps = new PointSeries();
    ps.setSeries(HOURS, ramp(), ramp(-10));
    expect(ps.reading(-5)!.temperatureC).toBe(0);
    expect(ps.reading(99)!.temperatureC).toBe(48);
  });

  it("reports nothing for a masked cell", () => {
    // A NaN in the series must not render as a number.
    const temps = ramp();
    temps[12] = NaN;
    const ps = new PointSeries();
    ps.setSeries(HOURS, temps, ramp(-10));
    expect(ps.reading(12)).toBeNull();
    // Neighbouring hours that bracket the NaN are affected too...
    expect(ps.reading(11.5)).toBeNull();
    // ...but hours away from it still read fine.
    expect(ps.reading(6)!.temperatureC).toBe(6);
  });

  it("handles a series whose lead axis is not hourly", () => {
    const hours = [0, 6, 12, 18];
    const ps = new PointSeries();
    ps.setSeries(hours, Float32Array.from([10, 20, 30, 40]), Float32Array.from([0, 1, 2, 3]));
    expect(ps.reading(6)).toEqual({ temperatureC: 20, dewpointC: 1 });
    expect(ps.reading(9)!.temperatureC).toBeCloseTo(25);
  });

  it("clear() drops the series", () => {
    const ps = new PointSeries();
    ps.setSeries(HOURS, ramp(), ramp(-10));
    ps.clear();
    expect(ps.loaded).toBe(false);
    expect(ps.reading(0)).toBeNull();
  });
});
