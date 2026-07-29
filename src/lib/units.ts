/**
 * Display-unit conversion and formatting. The store, decoder and colormaps all
 * work in metric throughout — only the strings the user reads are converted, so
 * switching systems never touches loaded data or palette thresholds.
 */

export type UnitSystem = "metric" | "imperial";

/**
 * The physical quantity a displayed number represents. Smoke's µg/m³ is a
 * scientific concentration with no imperial counterpart in common use (US AQI
 * reporting uses µg/m³ too), so `density` deliberately formats identically in
 * both systems.
 */
export type Quantity = "temperature" | "rate" | "density";

const MM_PER_INCH = 25.4;

export function toDisplay(value: number, quantity: Quantity, system: UnitSystem): number {
  if (system === "metric") return value;
  switch (quantity) {
    case "temperature":
      return value * 1.8 + 32;
    case "rate":
      return value / MM_PER_INCH;
    case "density":
      return value;
  }
}

export function unitLabel(quantity: Quantity, system: UnitSystem): string {
  switch (quantity) {
    case "temperature":
      return system === "metric" ? "°C" : "°F";
    case "rate":
      return system === "metric" ? "mm/hr" : "in/hr";
    case "density":
      return "µg/m³";
  }
}

/** Whole degrees, with -0 normalized so it never renders as "-0°C". */
export function formatTemperature(celsius: number, system: UnitSystem): string {
  const value = Math.round(toDisplay(celsius, "temperature", system)) || 0;
  return `${value}${unitLabel("temperature", system)}`;
}

/**
 * Trim a legend bound to a readable number of digits. Converted rates land on
 * awkward magnitudes (0.1 mm/hr is 0.0039 in/hr), so the precision follows the
 * value rather than being fixed.
 */
function formatBound(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 0 : abs >= 1 ? 1 : abs >= 0.1 ? 2 : 3;
  return value.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Legend range, e.g. `2–500 µg/m³` or `0.004–3.9 in/hr`. */
export function formatRange(
  lo: number,
  hi: number,
  quantity: Quantity,
  system: UnitSystem,
): string {
  const a = formatBound(toDisplay(lo, quantity, system));
  const b = formatBound(toDisplay(hi, quantity, system));
  return `${a}–${b} ${unitLabel(quantity, system)}`;
}

const STORAGE_KEY = "hrrr-map:units";

export function loadUnitSystem(): UnitSystem {
  try {
    return localStorage.getItem(STORAGE_KEY) === "imperial" ? "imperial" : "metric";
  } catch {
    // Private-mode / blocked storage: fall back to the default.
    return "metric";
  }
}

export function saveUnitSystem(system: UnitSystem): void {
  try {
    localStorage.setItem(STORAGE_KEY, system);
  } catch {
    // Preference just won't persist; not worth surfacing.
  }
}
