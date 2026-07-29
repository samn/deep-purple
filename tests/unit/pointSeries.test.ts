import { describe, expect, it } from "vitest";
import { PointSeries } from "../../src/lib/pointSeries.ts";

const HOURS = Array.from({ length: 49 }, (_, i) => i);

describe("PointSeries.bracket", () => {
  it("brackets a fractional time between adjacent leads", () => {
    const ps = new PointSeries(HOURS);
    expect(ps.bracket(9.4)).toEqual([9, 10]);
  });

  it("returns the same index when t lands on a lead", () => {
    const ps = new PointSeries(HOURS);
    expect(ps.bracket(12)).toEqual([12, 12]);
  });

  it("clamps at the edges of the range", () => {
    const ps = new PointSeries(HOURS);
    expect(ps.bracket(-5)).toEqual([0, 0]);
    expect(ps.bracket(60)).toEqual([48, 48]);
  });
});

describe("PointSeries.reading", () => {
  it("returns null until a bracketing lead is loaded", () => {
    const ps = new PointSeries(HOURS);
    expect(ps.reading(9.5)).toBeNull();
  });

  it("linearly interpolates between two loaded brackets", () => {
    const ps = new PointSeries(HOURS);
    ps.set(9, { temperatureC: 20, dewpointC: 10 });
    ps.set(10, { temperatureC: 24, dewpointC: 14 });
    const r = ps.reading(9.25)!;
    expect(r.temperatureC).toBeCloseTo(21);
    expect(r.dewpointC).toBeCloseTo(11);
  });

  it("falls back to whichever side is loaded", () => {
    const ps = new PointSeries(HOURS);
    ps.set(9, { temperatureC: 20, dewpointC: 10 });
    // Only the lower bracket cached: use it rather than returning null.
    expect(ps.reading(9.5)).toEqual({ temperatureC: 20, dewpointC: 10 });
  });

  it("returns the exact value when t lands on a loaded lead", () => {
    const ps = new PointSeries(HOURS);
    ps.set(12, { temperatureC: 31.6, dewpointC: 12.2 });
    expect(ps.reading(12)).toEqual({ temperatureC: 31.6, dewpointC: 12.2 });
  });

  it("clear() drops cached readings", () => {
    const ps = new PointSeries(HOURS);
    ps.set(0, { temperatureC: 5, dewpointC: 1 });
    expect(ps.has(0)).toBe(true);
    ps.clear();
    expect(ps.has(0)).toBe(false);
    expect(ps.reading(0)).toBeNull();
  });
});
