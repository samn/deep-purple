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

  it("interpolates between the nearest cached leads, not just adjacent ones", () => {
    // Sparse cache, as the on-demand sampler produces: t=15 sits between the
    // two cached leads even though neither is its hourly neighbour.
    const ps = new PointSeries(HOURS);
    ps.set(0, { temperatureC: 10, dewpointC: 0 });
    ps.set(30, { temperatureC: 40, dewpointC: 30 });
    const r = ps.reading(15)!;
    expect(r.temperatureC).toBeCloseTo(25);
    expect(r.dewpointC).toBeCloseTo(15);
  });

  it("holds the nearest cached value rather than blanking while a sample loads", () => {
    // Scrubbing from 0 to 30 with only lead 0 cached must keep showing a
    // value (slightly stale) instead of hiding the readout.
    const ps = new PointSeries(HOURS);
    ps.set(0, { temperatureC: 31, dewpointC: 10 });
    expect(ps.reading(30)).toEqual({ temperatureC: 31, dewpointC: 10 });
    // Once the lead-30 sample lands it takes over exactly.
    ps.set(30, { temperatureC: 33, dewpointC: 4 });
    expect(ps.reading(30)).toEqual({ temperatureC: 33, dewpointC: 4 });
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
