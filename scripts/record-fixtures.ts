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
 * Usage: npm run record-fixtures [-- --fresh]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYERS, POINT_VARIABLES, STORE_URL } from "../src/config.ts";
import { loadField, openArrays, openHrrrDataset } from "../src/lib/store.ts";

const OUT_DIR = join(import.meta.dirname, "..", "tests", "fixtures", "http");
const MANIFEST = join(OUT_DIR, "manifest.json");
const COARSE_LEADS = [0, 6, 12, 18, 24, 30, 36, 42, 48];
/**
 * Leads sampled for the point readout. Deliberately a small subset of
 * COARSE_LEADS: each one is a full-grid GRIB message per variable, and the
 * readout tests only need a starting value and one scrub target. 0 and 30 are
 * 12 h apart in local time, so the pair straddles the diurnal cycle and the
 * temperature visibly changes between them.
 */
const POINT_LEADS = [0, 30];

const fresh = process.argv.includes("--fresh");

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
let added = 0;

const origFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const range = headers.get("range") ?? "";
  const key = `${url}|${range}`;

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

// Point-readout variables: opened lazily by the worker, so record them the
// same way here.
await openArrays(
  dataset,
  POINT_VARIABLES.map((v) => ({ name: v.arrayName, scale: 1 })),
);
for (const v of POINT_VARIABLES) {
  for (const lead of POINT_LEADS) {
    await loadField(dataset, { name: v.arrayName, scale: 1 }, dataset.latestInitIndex, lead);
  }
}

const manifest = {
  recordedAt: new Date().toISOString(),
  initTimeMs: initTime.getTime(),
  initTimeIso: initTime.toISOString(),
  latestInitIndex: dataset.latestInitIndex,
  coarseLeads: COARSE_LEADS,
  pointLeads: POINT_LEADS,
  entries: [...entries.values()],
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + "\n");

let total = 0;
for (const e of entries.values()) if (e.file) total++;
console.log(`\nwrote ${total} bodies + manifest.json to ${OUT_DIR} (${added} new)`);
