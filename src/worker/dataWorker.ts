/**
 * Data worker: owns the icechunk store, decodes GRIB chunks, quantizes
 * fields, and paints requested frames into RGBA canvas pixels. Frames, the
 * reprojection index map, and the palette LUTs all live here so the main
 * thread only ever blits finished pixels.
 */
import { LAYERS, LOAD_PASSES, POINT_STORE_URL, POINT_VARIABLES, TEMPERATURE_VARIABLE, DEWPOINT_VARIABLE, type LayerConfig } from "../config.ts";
import { makeLut, makeQuantizer, quantizeField, PRECIP_COLORMAP, SMOKE_COLORMAP, type Quantizer } from "../lib/colormap.ts";
import { HRRR_GRID } from "../lib/lcc.ts";
import { buildIndexMap, paintFrame, type IndexMap } from "../lib/reproject.ts";
import { loadField, loadPointSeries, openHrrrDataset, openPointDataset, type HrrrDataset, type PointDataset } from "../lib/store.ts";
import type { MainToWorker, PaintRequest, SampleRequest, WorkerToMain } from "./protocol.ts";
import { progressiveLeadOrder } from "./schedule.ts";

const COLORMAPS = { precip: PRECIP_COLORMAP, smoke: SMOKE_COLORMAP } as const;

const post = (msg: WorkerToMain, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

interface LayerState {
  config: LayerConfig;
  quantizer: Quantizer;
  lut: Uint8ClampedArray;
  frames: (Uint8Array | null)[];
}

let dataset: HrrrDataset | null = null;
let layers: LayerState[] = [];
let indexMap: IndexMap | null = null;
let downsample = 1;
let sendFrameBytes = false;
let frameNy = 0;
let frameNx = 0;

async function handleOpen(storeUrl: string, layerIds: string[], factor: number, canvasWidth: number) {
  layers = layerIds.map((id) => {
    const config = LAYERS.find((l) => l.id === id);
    if (!config) throw new Error(`Unknown layer ${id}`);
    return {
      config,
      quantizer: makeQuantizer(COLORMAPS[config.id]),
      lut: makeLut(COLORMAPS[config.id]),
      frames: [],
    };
  });
  downsample = factor;
  frameNy = Math.ceil(HRRR_GRID.ny / factor);
  frameNx = Math.ceil(HRRR_GRID.nx / factor);

  // Build the reprojection map while the store handshake round-trips.
  const indexMapPromise = Promise.resolve().then(() =>
    buildIndexMap(HRRR_GRID, canvasWidth, frameNy, frameNx),
  );

  dataset = await openHrrrDataset(
    storeUrl,
    layers.map((l) => ({ name: l.config.arrayName, scale: l.config.scale })),
  );
  const numLeads = dataset.leadTimeHours.length;
  for (const layer of layers) {
    layer.frames = new Array<Uint8Array | null>(numLeads).fill(null);
  }
  indexMap = await indexMapPromise;

  post({
    type: "opened",
    initTimeMs: dataset.initTimes[dataset.latestInitIndex]!.getTime(),
    leadHours: dataset.leadTimeHours,
    indexWidth: indexMap.width,
    indexHeight: indexMap.height,
    corners: indexMap.corners,
  });
}

async function handleLoadAll() {
  if (!dataset) throw new Error("Store not opened");
  const ds = dataset;
  const passes = progressiveLeadOrder(ds.leadTimeHours.length, LOAD_PASSES);
  const total = passes.reduce((a, p) => a + p.length, 0) * layers.length;
  let loaded = 0;
  let firstPassDone = false;
  const firstPassCount = passes[0]!.length * layers.length;

  const queue: { layer: LayerState; leadIndex: number }[] = [];
  for (const pass of passes) {
    for (const leadIndex of pass) {
      for (const layer of layers) queue.push({ layer, leadIndex });
    }
  }

  const CONCURRENCY = 6;
  let next = 0;
  const runOne = async () => {
    while (next < queue.length) {
      const job = queue[next++]!;
      try {
        const { values, ny, nx } = await loadField(
          ds,
          { name: job.layer.config.arrayName, scale: job.layer.config.scale },
          ds.latestInitIndex,
          job.leadIndex,
        );
        const q = quantizeField(job.layer.quantizer, values, ny, nx, downsample);
        if (sendFrameBytes) {
          post(
            { type: "frameLoaded", layerId: job.layer.config.id, leadIndex: job.leadIndex, data: q.data },
            [q.data.buffer],
          );
        } else {
          job.layer.frames[job.leadIndex] = q.data;
          post({ type: "frameLoaded", layerId: job.layer.config.id, leadIndex: job.leadIndex });
        }
      } catch (e) {
        post({
          type: "frameError",
          layerId: job.layer.config.id,
          leadIndex: job.leadIndex,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      loaded++;
      if (!firstPassDone && loaded >= firstPassCount) firstPassDone = true;
      post({ type: "progress", loaded, total, firstPassDone });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, runOne));
}

/**
 * Paint requested frames into RGBA buffers and transfer them back. Always
 * answers with a `painted` message (possibly empty) so the main thread's
 * in-flight bookkeeping never wedges.
 */
function handlePaint(req: PaintRequest): void {
  const map = indexMap;
  if (!map) {
    post({ type: "painted", frames: [] });
    return;
  }
  const byteLength = map.width * map.height * 4;
  const pool = req.recycle.filter((b) => b.byteLength === byteLength);
  const frames: { layerId: string; pixels: Uint8ClampedArray<ArrayBuffer> }[] = [];
  const transfers: Transferable[] = [];
  try {
    for (const job of req.jobs) {
      const layer = layers.find((l) => l.config.id === job.layerId);
      const frameA = layer?.frames[job.a];
      if (!layer || !frameA) continue;
      const frameB = job.b !== job.a ? (layer.frames[job.b] ?? null) : null;
      const pixels = new Uint8ClampedArray(pool.pop() ?? new ArrayBuffer(byteLength));
      paintFrame(map, layer.lut, pixels, frameA, frameB, job.blend);
      frames.push({ layerId: job.layerId, pixels });
      transfers.push(pixels.buffer);
    }
  } catch (e) {
    console.warn("paint failed:", e);
  } finally {
    post({ type: "painted", frames }, transfers);
  }
}

/**
 * The time-optimized point store, opened on first use. Kept separate from the
 * map's store and out of the initial handshake: the map must not wait on it,
 * and a store that can't be reached should cost nothing but the readout. A
 * failed attempt is not memoized, so a transient error can self-heal.
 */
let pointDataset: Promise<PointDataset> | null = null;
function ensurePointDataset(): Promise<PointDataset> {
  pointDataset ??= openPointDataset(
    POINT_STORE_URL,
    POINT_VARIABLES.map((v) => v.arrayName),
  ).catch((e: unknown) => {
    pointDataset = null;
    throw e;
  });
  return pointDataset;
}

/** Aborts the in-flight read of a superseded location. */
let sampleAbort: { requestId: number; controller: AbortController } | null = null;

/**
 * Read the whole temperature + dew point series at one cell. Answers with
 * exactly one message so the main thread's bookkeeping can never wedge; the
 * map keeps working regardless of what happens here.
 */
async function handleSample(req: SampleRequest): Promise<void> {
  const fail = (retryable: boolean, message: string) =>
    post({ type: "sampleFailed", requestId: req.requestId, retryable, message });

  if (!sampleAbort || sampleAbort.requestId !== req.requestId) {
    sampleAbort?.controller.abort();
    sampleAbort = { requestId: req.requestId, controller: new AbortController() };
  }
  const { signal } = sampleAbort.controller;

  let ds: PointDataset;
  try {
    ds = await ensurePointDataset();
  } catch (e) {
    fail(true, `point store unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Match the map's run by timestamp: the two stores are published separately,
  // so an index that is right for one can be wrong for the other, and showing a
  // different run's numbers beside the map would be worse than showing none.
  const initIndex = ds.initTimes.findIndex((d) => d.getTime() === req.initTimeMs);
  if (initIndex === -1) {
    fail(true, `point store has no init at ${new Date(req.initTimeMs).toISOString()}`);
    return;
  }

  try {
    const [temperatureC, dewpointC] = await Promise.all([
      loadPointSeries(ds, TEMPERATURE_VARIABLE.arrayName, initIndex, req.col, req.row, signal),
      loadPointSeries(ds, DEWPOINT_VARIABLE.arrayName, initIndex, req.col, req.row, signal),
    ]);
    post(
      {
        type: "sampleSeries",
        requestId: req.requestId,
        leadHours: ds.leadTimeHours,
        temperatureC,
        dewpointC,
      },
      [temperatureC.buffer, dewpointC.buffer],
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    fail(!signal.aborted, message);
  }
}

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  const fail = (e: unknown) =>
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  if (msg.type === "open") {
    sendFrameBytes = msg.sendFrameBytes;
    handleOpen(msg.storeUrl, msg.layerIds, msg.downsample, msg.canvasWidth).catch(fail);
  } else if (msg.type === "loadAll") {
    handleLoadAll().catch(fail);
  } else if (msg.type === "paint") {
    handlePaint(msg);
  } else if (msg.type === "sample") {
    // Sampling failures must never surface as a fatal store error; the map
    // and animation work fine without the readout.
    handleSample(msg).catch((e) => console.warn("sample failed:", e));
  }
};
