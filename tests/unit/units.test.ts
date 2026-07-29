import { describe, expect, it } from "vitest";
import { PRECIP_LAYER, SMOKE_LAYER } from "../../src/config.ts";
import { formatRange, formatTemperature, toDisplay, unitLabel } from "../../src/lib/units.ts";

describe("temperature", () => {
  it("converts and labels both systems", () => {
    expect(formatTemperature(0, "metric")).toBe("0°C");
    expect(formatTemperature(0, "imperial")).toBe("32°F");
    expect(formatTemperature(31.333, "metric")).toBe("31°C");
    expect(formatTemperature(31.333, "imperial")).toBe("88°F");
    expect(formatTemperature(-40, "imperial")).toBe("-40°F");
  });

  it("never renders a negative zero", () => {
    // Math.round(-0.2) is -0, which would stringify as "-0°C".
    expect(formatTemperature(-0.2, "metric")).toBe("0°C");
    expect(formatTemperature(-17.8, "imperial")).toBe("0°F");
  });
});

describe("legend ranges", () => {
  it("converts rain rate to inches per hour", () => {
    expect(formatRange(...PRECIP_LAYER.range, PRECIP_LAYER.quantity, "metric")).toBe(
      "0.1–100 mm/hr",
    );
    // 0.1 mm/hr -> 0.0039 in/hr, 100 mm/hr -> 3.94 in/hr.
    expect(formatRange(...PRECIP_LAYER.range, PRECIP_LAYER.quantity, "imperial")).toBe(
      "0.004–3.9 in/hr",
    );
  });

  it("leaves smoke concentration alone in both systems", () => {
    // µg/m³ has no imperial counterpart in common use — US AQI reporting uses
    // it too — so the density legend must be identical either way.
    const metric = formatRange(...SMOKE_LAYER.range, SMOKE_LAYER.quantity, "metric");
    const imperial = formatRange(...SMOKE_LAYER.range, SMOKE_LAYER.quantity, "imperial");
    expect(metric).toBe("2–500 µg/m³");
    expect(imperial).toBe(metric);
  });
});

describe("toDisplay / unitLabel", () => {
  it("is identity for metric", () => {
    for (const q of ["temperature", "rate", "density"] as const) {
      expect(toDisplay(12.5, q, "metric")).toBe(12.5);
    }
  });

  it("labels each quantity per system", () => {
    expect(unitLabel("temperature", "metric")).toBe("°C");
    expect(unitLabel("temperature", "imperial")).toBe("°F");
    expect(unitLabel("rate", "metric")).toBe("mm/hr");
    expect(unitLabel("rate", "imperial")).toBe("in/hr");
    expect(unitLabel("density", "metric")).toBe("µg/m³");
    expect(unitLabel("density", "imperial")).toBe("µg/m³");
  });

  it("round-trips a rate through the inch conversion", () => {
    expect(toDisplay(25.4, "rate", "imperial")).toBeCloseTo(1);
  });
});
