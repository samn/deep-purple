/**
 * Records the HTTP traffic needed for deterministic Playwright tests: opens
 * the real icechunk store, loads the coarse-pass frames for both overlay
 * layers, and samples the point-readout variables, saving every request body
 * to tests/fixtures/http/ plus a manifest keyed by URL + Range header. The
 * Playwright suite replays these with page.route.
 *
 * Incremental by default: bodies already in the manifest are replayed from
 * disk rather than refetched, so the recorded init time — and therefore the
 * committed visual snapshots — stay put while new requests are appended. Pass
 * --fresh to wipe the directory and re-record against the latest store init
 * (this changes initTimeMs and requires `npm run test:e2e:update`).
 *
 * Usage: npm run record-fixtures [-- --fresh] [-- --prune]
 *
 * --prune drops manifest entries and bodies this run never requested, which is
 * how fixtures for a replaced data path get cleaned up.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYERS, POINT_STORE_URL, POINT_VARIABLES, STORE_URL } from "../src/config.ts";
import { HRRR_GRID, makeGridTransform } from "../src/lib/lcc.ts";
import { loadField, loadPointSeries, openHrrrDataset, openPointDataset } from "../src/lib/store.ts";

const OUT_DIR = join(import.meta.dirname, "..", "tests", "fixtures", "http");
const MANIFEST = join(OUT_DIR, "manifest.json");
const COARSE_LEADS = [0, 6, 12, 18, 24, 30, 36, 42, 48];
/**
 * Location whose point readout the e2e specs assert on; must match the
 * geolocation they set. One read covers every lead, so no lead list is needed.
 */
const POINT_LON = -104.99;
const POINT_LAT = 39.74;

const fresh = process.argv.includes("--fresh");
const prune = process.argv.includes("--prune");

interface FixtureEntry {
  url: string;
  range: string;
  status: number;
  file: string | null;
  contentType: string;
}

if (fresh) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const entries = new Map<string, FixtureEntry>();
if (!fresh && existsSync(MANIFEST)) {
  const prior = JSON.parse(readFileSync(MANIFEST, "utf8")) as { entries: FixtureEntry[] };
  for (const e of prior.entries) entries.set(`${e.url}|${e.range}`, e);
  console.log(`reusing ${entries.size} recorded entries (pass --fresh to re-record from scratch)`);
}
/** Entries present when we started: replayed from disk, never refetched. */
const cached = new Set(entries.keys());
/** Keys this run asked for, so --prune can drop the rest. */
const requested = new Set<string>();
let added = 0;

const origFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const range = headers.get("range") ?? "";
  const key = `${url}|${range}`;
  requested.add(key);

  // Replay anything we already hold so the recorded store state (and thus the
  // init time the snapshots were taken at) is reproduced exactly.
  const hit = cached.has(key) ? entries.get(key) : undefined;
  if (hit) {
    const body = hit.file ? readFileSync(join(OUT_DIR, hit.file)) : new Uint8Array();
    return new Response(hit.file ? body : null, {
      status: hit.status,
      headers: { "content-type": hit.contentType },
    });
  }

  const res = await origFetch(input, init);
  if (!entries.has(key)) {
    const body = new Uint8Array(await res.clone().arrayBuffer());
    let file: string | null = null;
    if (res.ok) {
      file = createHash("sha1").update(key).digest("hex").slice(0, 20) + ".bin";
      writeFileSync(join(OUT_DIR, file), body);
    }
    entries.set(key, {
      url,
      range,
      status: res.status,
      file,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    });
    added++;
    console.log(`+ ${res.status} ${(body.length / 1024).toFixed(1)}kB ${url.slice(0, 110)} ${range}`);
  }
  return res;
}) as typeof fetch;

const dataset = await openHrrrDataset(
  STORE_URL,
  LAYERS.map((l) => ({ name: l.arrayName, scale: l.scale })),
);
const initTime = dataset.initTimes[dataset.latestInitIndex]!;
console.log(`\nrecording init ${initTime.toISOString()} (index ${dataset.latestInitIndex})`);

for (const layer of LAYERS) {
  for (const lead of COARSE_LEADS) {
    await loadField(dataset, { name: layer.arrayName, scale: layer.scale }, dataset.latestInitIndex, lead);
  }
}

// Point readout: a separate, time-optimized store, read at the same init the
// map is pinned to so the recorded numbers match the recorded frames.
const pointDataset = await openPointDataset(
  POINT_STORE_URL,
  POINT_VARIABLES.map((v) => v.arrayName),
);
const pointInitIndex = pointDataset.initTimes.findIndex(
  (d) => d.getTime() === initTime.getTime(),
);
if (pointInitIndex === -1) {
  throw new Error(
    `point store has no init at ${initTime.toISOString()}; cannot record a consistent readout`,
  );
}
const [pcol, prow] = makeGridTransform(HRRR_GRID).lonLatToGrid(POINT_LON, POINT_LAT);
for (const v of POINT_VARIABLES) {
  await loadPointSeries(
    pointDataset,
    v.arrayName,
    pointInitIndex,
    Math.round(pcol),
    Math.round(prow),
  );
}

if (prune) {
  // Drop bodies nothing asked for this run (e.g. fixtures for a data path that
  // has since been replaced). Safe because this script requests exactly what
  // the app does; without it the committed set only ever grows.
  let removed = 0;
  for (const [key, entry] of [...entries]) {
    if (requested.has(key)) continue;
    entries.delete(key);
    if (entry.file && existsSync(join(OUT_DIR, entry.file))) {
      rmSync(join(OUT_DIR, entry.file));
      removed++;
    }
  }
  console.log(`pruned ${removed} unused bodies`);
}

const manifest = {
  recordedAt: new Date().toISOString(),
  initTimeMs: initTime.getTime(),
  initTimeIso: initTime.toISOString(),
  latestInitIndex: dataset.latestInitIndex,
  coarseLeads: COARSE_LEADS,
  point: { lon: POINT_LON, lat: POINT_LAT },
  entries: [...entries.values()],
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + "\n");

let total = 0;
for (const e of entries.values()) if (e.file) total++;
console.log(`\nwrote ${total} bodies + manifest.json to ${OUT_DIR} (${added} new)`);
