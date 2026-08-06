/**
 * Dev utility: inspect the dynamical.org HRRR icechunk stores the map splices
 * — node hierarchy, zarr metadata for the arrays we use, coordinate values, and
 * a sample chunk read. Pass a store URL to inspect just that one (e.g. the
 * point readout's).
 * Usage: node --experimental-strip-types scripts/inspect-store.ts [url]
 */
import { IcechunkStore } from "icechunk-js";
import { MAP_STORE_URLS } from "../src/config.ts";

const urls = process.argv[2] ? [process.argv[2]] : MAP_STORE_URLS;

for (const url of urls) {
  console.log(`\n########## ${url}`);
  const store = await IcechunkStore.open(url);
  console.log("snapshot:", store.session.getSnapshotId());

  const children = store.listChildren("/");
  console.log("root children:", children);

  for (const path of ["/", "/precipitation_rate_surface", "/mass_density_8m", "/init_time", "/lead_time", "/x", "/y"]) {
    try {
      const meta = store.getMetadata(path);
      console.log(`\n=== ${path}`);
      console.log(JSON.stringify(meta, null, 1).slice(0, 2500));
    } catch (e) {
      console.log(`\n=== ${path}: ERROR ${(e as Error).message}`);
    }
  }
}
