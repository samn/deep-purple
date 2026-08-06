/**
 * End-to-end spike: open both real map stores, find each one's latest complete
 * init, splice them into the timeline the app shows, read one precip + one
 * smoke field through zarrita + the gribberish codec, and report network usage.
 * Usage: node --experimental-strip-types scripts/spike-read.ts
 */
import { MAP_STORE_URLS, PRECIP_LAYER, SMOKE_LAYER } from "../src/config.ts";
import { spliceRuns } from "../src/lib/splice.ts";
import { loadField, openHrrrDataset } from "../src/lib/store.ts";
import { unitLabel } from "../src/lib/units.ts";

let requests = 0;
let bytes = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  requests++;
  const res = await origFetch(input, init);
  const len = res.headers.get("content-length");
  if (len) bytes += Number(len);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  console.log(`  [net] ${res.status} ${(Number(len) / 1024).toFixed(1)}kB ${url.slice(0, 130)}`);
  return res;
}) as typeof fetch;

const t0 = performance.now();
const datasets = await Promise.all(
  MAP_STORE_URLS.map((url) =>
    openHrrrDataset(url, [
      { name: PRECIP_LAYER.arrayName, scale: PRECIP_LAYER.scale },
      { name: SMOKE_LAYER.arrayName, scale: SMOKE_LAYER.scale },
    ]),
  ),
);
console.log(`\nopened in ${(performance.now() - t0).toFixed(0)}ms; ${requests} requests, ${(bytes / 1024 / 1024).toFixed(2)}MB`);
datasets.forEach((d, i) => {
  console.log(`\n${MAP_STORE_URLS[i]}`);
  console.log(`  inits: ${d.initTimes.length}, latest complete: #${d.latestInitIndex} = ${d.initTimes[d.latestInitIndex]!.toISOString()}`);
  console.log(`  leads: ${d.leadTimeHours.length} (${d.leadTimeHours[0]}..${d.leadTimeHours.at(-1)}h)`);
});

const timeline = spliceRuns(
  datasets.map((d) => ({
    initTimeMs: d.initTimes[d.latestInitIndex]!.getTime(),
    leadHours: d.leadTimeHours,
  })),
);
const perStore = timeline.sources.reduce<Record<number, number>>((acc, s) => {
  acc[s.runIndex] = (acc[s.runIndex] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `\nspliced: ${timeline.leadHours.length} hours from ${new Date(timeline.initTimeMs).toISOString()} ` +
  `(+0..+${timeline.leadHours.at(-1)}h); frames per store: ${JSON.stringify(perStore)}`,
);

const ds = datasets[0]!;
for (const layer of [PRECIP_LAYER, SMOKE_LAYER]) {
  const t1 = performance.now();
  const { values, ny, nx } = await loadField(ds, { name: layer.arrayName, scale: layer.scale }, ds.latestInitIndex, 6);
  let min = Infinity, max = -Infinity, nan = 0, sum = 0;
  for (const v of values) {
    if (Number.isNaN(v)) { nan++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  console.log(
    `${layer.id}: ${ny}x${nx} in ${(performance.now() - t1).toFixed(0)}ms; ` +
    `min=${min.toExponential(2)} max=${max.toExponential(2)} mean=${(sum / values.length).toExponential(2)} nan=${nan} ${unitLabel(layer.quantity, "metric")}`,
  );
}
console.log(`\ntotal: ${requests} requests, ${(bytes / 1024 / 1024).toFixed(2)}MB`);
