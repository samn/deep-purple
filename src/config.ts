/** Application configuration: data store, variables, rendering. */

export const STORE_URL =
  "https://dynamical-noaa-hrrr.s3.amazonaws.com/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk";

export interface LayerConfig {
  id: "precip" | "smoke";
  label: string;
  /** Zarr array name. */
  arrayName: string;
  /** Multiply raw store values by this to get display units. */
  scale: number;
  units: string;
}

/** Precipitation rate: kg m-2 s-1 → mm/hr. */
export const PRECIP_LAYER: LayerConfig = {
  id: "precip",
  label: "Rain",
  arrayName: "precipitation_rate_surface",
  scale: 3600,
  units: "mm/hr",
};

/** Near-surface smoke: kg m-3 → µg/m³. */
export const SMOKE_LAYER: LayerConfig = {
  id: "smoke",
  label: "Smoke",
  arrayName: "mass_density_8m",
  scale: 1e9,
  units: "µg/m³",
};

export const LAYERS: LayerConfig[] = [SMOKE_LAYER, PRECIP_LAYER];

/**
 * Single-point ("readout") variables sampled at the user's location rather
 * than rendered as overlays. The store applies a scale_offset codec on read,
 * so these arrive already in °C — no display scaling needed.
 */
export interface PointVariable {
  id: "temperature" | "dewpoint";
  label: string;
  /** Zarr array name. */
  arrayName: string;
  units: string;
}

export const TEMPERATURE_VARIABLE: PointVariable = {
  id: "temperature",
  label: "Temp",
  arrayName: "temperature_2m",
  units: "°C",
};

export const DEWPOINT_VARIABLE: PointVariable = {
  id: "dewpoint",
  label: "Dew pt",
  arrayName: "dew_point_temperature_2m",
  units: "°C",
};

export const POINT_VARIABLES: PointVariable[] = [TEMPERATURE_VARIABLE, DEWPOINT_VARIABLE];

/**
 * Sample the readout only at leads on this hour stride (0, 6, 12, … plus the
 * final lead). Chunks are whole-grid, so every extra lead costs a full GRIB
 * message *per variable* (~1.25 MB) — sampling all 49 leads during one
 * playthrough would pull ~118 MB, more than the whole rest of the app. A
 * 6-hour stride caps the readout at 9 leads (~22 MB worst case, and only for
 * the leads actually visited) while still resolving the diurnal swing; values
 * in between are interpolated by PointSeries.
 */
export const READOUT_LEAD_STRIDE_HOURS = 6;

/** Max concurrent point-sample requests, so sampling can't starve frame loading. */
export const READOUT_MAX_INFLIGHT = 2;

/**
 * Attempts allowed per lead before it is given up on for the current location.
 * A retryable failure frees the lead for another try, and refreshReadout runs
 * on every timeline tick — without a cap that becomes a request loop against a
 * lead the store simply can't serve.
 */
export const READOUT_MAX_ATTEMPTS = 3;

export const BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/** Number of lead-time frames (0..48 h hourly). */
export const NUM_LEADS = 49;

/** Progressive loading passes: hour strides, coarse first. */
export const LOAD_PASSES = [6, 3, 1];
