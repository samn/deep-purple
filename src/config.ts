/** Application configuration: data store, variables, rendering. */
import type { Quantity } from "./lib/units.ts";

export const STORE_URL =
  "https://dynamical-noaa-hrrr.s3.amazonaws.com/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk";

export interface LayerConfig {
  id: "precip" | "smoke";
  label: string;
  /** Zarr array name. */
  arrayName: string;
  /** Multiply raw store values by this to get metric display units. */
  scale: number;
  /** Physical quantity, so the legend can be relabelled per unit system. */
  quantity: Quantity;
  /** Legend bounds in metric units (matches the colormap's end stops). */
  range: [number, number];
}

/** Precipitation rate: kg m-2 s-1 → mm/hr. */
export const PRECIP_LAYER: LayerConfig = {
  id: "precip",
  label: "Rain",
  arrayName: "precipitation_rate_surface",
  scale: 3600,
  quantity: "rate",
  range: [0.1, 100],
};

/** Near-surface smoke: kg m-3 → µg/m³. */
export const SMOKE_LAYER: LayerConfig = {
  id: "smoke",
  label: "Smoke",
  arrayName: "mass_density_8m",
  scale: 1e9,
  quantity: "density",
  range: [2, 500],
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
  quantity: Quantity;
}

export const TEMPERATURE_VARIABLE: PointVariable = {
  id: "temperature",
  label: "Temp",
  arrayName: "temperature_2m",
  quantity: "temperature",
};

export const DEWPOINT_VARIABLE: PointVariable = {
  id: "dewpoint",
  label: "Dew",
  arrayName: "dew_point_temperature_2m",
  quantity: "temperature",
};

export const POINT_VARIABLES: PointVariable[] = [TEMPERATURE_VARIABLE, DEWPOINT_VARIABLE];

/**
 * Time-optimized companion store for the point readout
 * (dynamical.org/catalog/noaa-hrrr-forecast-48-hour).
 *
 * The map reads the *map-optimized* virtual store, whose chunks are one whole
 * grid per (init, lead) — ideal for painting a frame, terrible for one cell:
 * 49 leads x 2 variables would be ~118 MB of GRIB to read 98 numbers. This
 * store holds the same forecast rechunked with all 49 lead times together and
 * sharded across y/x, so a single cell's entire 48-hour series is one ~3 MB
 * inner-chunk read per variable — the whole readout costs ~6 MB at full hourly
 * resolution. Values arrive in °C, float32, blosc/zstd (no GRIB decode).
 */
export const POINT_STORE_URL =
  "https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-forecast-48-hour/v0.1.0.icechunk";

/**
 * Attempts allowed for the point series before giving up for this location.
 * The read is one shot per location, so this only guards transient failures.
 */
export const READOUT_MAX_ATTEMPTS = 2;

/** Wait before retrying a failed point read, so a retry isn't spent instantly. */
export const READOUT_RETRY_DELAY_MS = 2000;

export const BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/** Number of lead-time frames (0..48 h hourly). */
export const NUM_LEADS = 49;

/** Progressive loading passes: hour strides, coarse first. */
export const LOAD_PASSES = [6, 3, 1];
