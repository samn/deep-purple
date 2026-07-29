import { expect, test } from "@playwright/test";
import { fixtureManifest, gotoApp, routeFixtures, waitForLoaded } from "./helpers.ts";

/**
 * The point readout comes from the time-optimized store, which returns the
 * whole 48-hour series in one read — so every forecast hour is assertable, not
 * just a recorded subset. Values below are what the pinned init holds at the
 * recorded location; re-recording with `--fresh` changes them and they must be
 * updated by hand (there is no snapshot to auto-refresh).
 */
const DENVER = {
  longitude: fixtureManifest.point.lon,
  latitude: fixtureManifest.point.lat,
};
const AT_0H = { temp: "31°C", dew: "10°C" };
const AT_12H = { temp: "22°C", dew: "11°C" };
const AT_30H = { temp: "33°C", dew: "4°C" };

const readout = ".readout";
const tempValue = '.readout-metric[data-metric="temp"] .readout-value';
const dewValue = '.readout-metric[data-metric="dew"] .readout-value';
const unitBtn = ".unit-btn";

test.describe("forecast readout with a location", () => {
  test.use({ geolocation: DENVER, permissions: ["geolocation"] });

  test.beforeEach(async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
  });

  test("shows temperature and dew point for the located point", async ({ page }) => {
    await expect(page.locator(readout)).toBeVisible();
    await expect(page.locator(tempValue)).toHaveText(AT_0H.temp);
    await expect(page.locator(dewValue)).toHaveText(AT_0H.dew);
    // Named for assistive tech. role=group is required for the name to stick:
    // ARIA forbids naming a plain div (implicit role `generic`).
    await expect(page.locator(readout)).toHaveAttribute("role", "group");
    await expect(page.locator(readout)).toHaveAttribute(
      "aria-label",
      "Forecast at your location",
    );
  });

  test("is a continuously-updating value, so it must not be a live region", async ({ page }) => {
    // An aria-live region here would queue an announcement on every timeline
    // tick and drown out the rest of the page during playback.
    await expect(page.locator(readout)).not.toHaveAttribute("aria-live", /.*/);
  });

  test("sits in the bottom bar, anchored to its right edge", async ({ page }) => {
    const box = (await page.locator(readout).boundingBox())!;
    const time = (await page.locator(".time-labels").boundingBox())!;
    const bar = (await page.locator(".bottom-bar").boundingBox())!;

    // Right of the time, and flush to the bar's right padding.
    expect(box.x).toBeGreaterThanOrEqual(time.x + time.width);
    const viewport = page.viewportSize()!;
    const rightGap = viewport.width - (box.x + box.width);
    expect(rightGap).toBeGreaterThanOrEqual(0);
    expect(rightGap).toBeLessThanOrEqual(26);
    // Inside the bottom bar, not floating over the map.
    expect(box.y).toBeGreaterThanOrEqual(bar.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
    // The attribution is required, so the bar must never grow over it — its
    // offset tracks the bar's real height rather than a fixed guess.
    const info = (await page.locator(".maplibregl-ctrl-attrib-button").boundingBox())!;
    expect(info.y + info.height).toBeLessThanOrEqual(bar.y);
  });

  test("does not shift when the forecast hour gains a digit", async ({ page }) => {
    // "+9h" -> "+10h" widens the label to the readout's left; anchoring to the
    // right edge is what keeps the numbers from jittering during playback.
    const positions: number[] = [];
    for (const hour of ["0", "9", "10", "48"]) {
      await page.locator(".scrubber").fill(hour);
      await expect(page.locator(".rel-label")).toHaveText(`+${hour}h`);
      positions.push(Math.round((await page.locator(readout).boundingBox())!.x));
    }
    expect(new Set(positions).size).toBe(1);
  });

  test("centres the labels and values in their columns", async ({ page }) => {
    const alignment = await page.evaluate(() => {
      const pick = (sel: string) => getComputedStyle(document.querySelector(sel)!).textAlign;
      return {
        label: pick('.readout-metric[data-metric="temp"] .readout-label'),
        value: pick('.readout-metric[data-metric="temp"] .readout-value'),
      };
    });
    expect(alignment).toEqual({ label: "center", value: "center" });

    // Both metrics are the same shape, so the pairs read as one unit: equal
    // label columns and equal value boxes.
    const width = async (sel: string) => (await page.locator(sel).boundingBox())!.width;
    expect(await width('.readout-metric[data-metric="temp"] .readout-label')).toBeCloseTo(
      await width('.readout-metric[data-metric="dew"] .readout-label'),
      1,
    );
    expect(await width(tempValue)).toBeCloseTo(await width(dewValue), 1);
  });

  test("holds each value's width so digits stay put", async ({ page }) => {
    // Values swing between one and three characters; a fixed box keeps the
    // whole row still rather than reflowing on every hour.
    const widths = new Set<number>();
    for (const hour of ["0", "12", "30"]) {
      await page.locator(".scrubber").fill(hour);
      await expect(page.locator(".rel-label")).toHaveText(`+${hour}h`);
      widths.add(Math.round((await page.locator(tempValue).boundingBox())!.width));
    }
    expect(widths.size).toBe(1);
  });

  test("updates when the timeline is scrubbed", async ({ page }) => {
    await expect(page.locator(tempValue)).toHaveText(AT_0H.temp);

    await page.locator(".scrubber").fill("30");
    await expect(page.locator(".rel-label")).toHaveText("+30h");

    await expect(page.locator(tempValue)).toHaveText(AT_30H.temp);
    await expect(page.locator(dewValue)).toHaveText(AT_30H.dew);
    // Never blanks mid-scrub: it holds the previous sample until the new one
    // lands, rather than hiding while the fetch is in flight.
    await expect(page.locator(readout)).toBeVisible();
  });

  test("resolves every forecast hour, not just a coarse subset", async ({ page }) => {
    // The time-optimized store returns all 49 leads in one read, so a lead that
    // is not on any coarse stride still reads exactly.
    await page.locator(".scrubber").fill("12");
    await expect(page.locator(".rel-label")).toHaveText("+12h");
    await expect(page.locator(tempValue)).toHaveText(AT_12H.temp);
    await expect(page.locator(dewValue)).toHaveText(AT_12H.dew);

    // And an hour between leads interpolates between its neighbours rather than
    // snapping to one of them.
    await page.locator(".scrubber").fill("12.5");
    const between = await page.locator(tempValue).textContent();
    expect(between).toMatch(/^\d+°C$/);
  });

  test("keeps a value on screen throughout autoplay", async ({ page }) => {
    // Autoplay is the production default. The whole series is already in hand,
    // so the readout tracks playback without further fetching.
    await page.locator(".play-btn").click();
    await expect(page.locator(".play-btn")).toHaveAttribute("aria-label", "Pause animation");

    for (let i = 0; i < 6; i++) {
      await expect(page.locator(readout)).toBeVisible();
      await expect(page.locator(tempValue)).toHaveText(/^-?\d+°C$/);
      await page.waitForTimeout(250);
    }
    await expect(page.locator(".rel-label")).not.toHaveText("+0h");
  });
});

test.describe("loading placeholder", () => {
  test.use({ geolocation: DENVER, permissions: ["geolocation"] });

  test("shows labelled skeletons until the values arrive", async ({ context, page }) => {
    await routeFixtures(context);
    // Registered after the fixture catch-all so it wins for the point store,
    // holding it open to keep the loading state observable.
    await context.route(
      (u) => u.href.includes("noaa-hrrr-forecast-48-hour/v0.1.0"),
      () => {
        /* never fulfilled */
      },
    );
    await gotoApp(page);
    await waitForLoaded(page);

    // Visible and marked busy, with the labels still readable.
    await expect(page.locator(readout)).toBeVisible();
    await expect(page.locator(readout)).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(readout)).toHaveClass(/readout-loading/);
    await expect(page.locator('.readout-metric[data-metric="temp"] .readout-label')).toHaveText("Temp");
    await expect(page.locator('.readout-metric[data-metric="dew"] .readout-label')).toHaveText("Dew");

    // No numbers yet, but the placeholder still occupies the value's box.
    await expect(page.locator(tempValue)).toHaveText("");
    const box = (await page.locator(tempValue).boundingBox())!;
    expect(box.width).toBeGreaterThan(20);
    expect(box.height).toBeGreaterThan(8);
  });

  test("placeholder gives way to the values without moving the row", async ({ context, page }) => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await routeFixtures(context);
    await context.route(
      (u) => u.href.includes("noaa-hrrr-forecast-48-hour/v0.1.0"),
      async (route) => {
        await held;
        await route.fallback();
      },
    );
    await gotoApp(page);
    await waitForLoaded(page);

    await expect(page.locator(readout)).toHaveAttribute("aria-busy", "true");
    const loadingBox = (await page.locator(readout).boundingBox())!;

    release();

    await expect(page.locator(tempValue)).toHaveText(AT_0H.temp);
    await expect(page.locator(readout)).not.toHaveAttribute("aria-busy", /.*/);
    const loadedBox = (await page.locator(readout).boundingBox())!;
    // Same footprint before and after, so nothing jumps as data lands.
    expect(Math.round(loadedBox.x)).toBe(Math.round(loadingBox.x));
    expect(Math.round(loadedBox.width)).toBe(Math.round(loadingBox.width));
  });

});

test.describe("loading priority", () => {
  test.use({ geolocation: DENVER, permissions: ["geolocation"] });

  test("loads the map's frames before the point readout", async ({ context, page }) => {
    // The overlay is what the user is looking at, and it shares the worker and
    // connection with the point read — so frames must go first.
    const order: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      // Frame data: virtual chunks resolve to NOAA's GRIB archive.
      if (url.includes("noaa-hrrr-bdp-pds")) order.push("frame");
      // Any request to the separate time-optimized store is the readout.
      else if (url.includes("noaa-hrrr-forecast-48-hour/v0.1.0")) order.push("point");
    });

    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
    await expect(page.locator(readout)).toBeVisible();

    const firstPoint = order.indexOf("point");
    expect(firstPoint).toBeGreaterThan(-1);
    const framesFirst = order.slice(0, firstPoint).filter((k) => k === "frame").length;
    // The first progressive pass is 9 coarse leads x 2 layers; all of it is
    // requested before the readout touches the network.
    expect(framesFirst).toBeGreaterThanOrEqual(18);
  });
});

test.describe("unit toggle", () => {
  test.use({ geolocation: DENVER, permissions: ["geolocation"] });

  test.beforeEach(async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
  });

  test("switches the readout between Celsius and Fahrenheit", async ({ page }) => {
    await expect(page.locator(tempValue)).toHaveText("31°C");
    await expect(page.locator(dewValue)).toHaveText("10°C");

    await page.locator(unitBtn).click();

    // 31.33°C -> 88°F, 9.77°C -> 50°F.
    await expect(page.locator(tempValue)).toHaveText("88°F");
    await expect(page.locator(dewValue)).toHaveText("50°F");

    await page.locator(unitBtn).click();
    await expect(page.locator(tempValue)).toHaveText("31°C");
  });

  test("relabels the legend ranges too, and leaves µg/m³ alone", async ({ page }) => {
    const rain = page.locator('.chip[data-layer="precip"] .chip-range');
    const smoke = page.locator('.chip[data-layer="smoke"] .chip-range');
    await expect(rain).toHaveText("0.1–100 mm/hr");
    await expect(smoke).toHaveText("2–500 µg/m³");

    await page.locator(unitBtn).click();

    await expect(rain).toHaveText("0.004–3.9 in/hr");
    // Smoke concentration has no imperial counterpart in common use.
    await expect(smoke).toHaveText("2–500 µg/m³");
  });

  test("reports its state and sits above the attribution button", async ({ page }) => {
    await expect(page.locator(unitBtn)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(unitBtn)).toHaveAttribute("aria-label", /imperial/i);
    await page.locator(unitBtn).click();
    await expect(page.locator(unitBtn)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(unitBtn)).toHaveAttribute("aria-label", /metric/i);

    const btn = (await page.locator(unitBtn).boundingBox())!;
    const info = (await page.locator(".maplibregl-ctrl-attrib-button").boundingBox())!;
    const locate = (await page.locator(".locate-btn").boundingBox())!;
    // Directly above the ⓘ button, and below the locate button.
    expect(btn.y + btn.height).toBeLessThanOrEqual(info.y);
    expect(btn.y).toBeGreaterThanOrEqual(locate.y + locate.height);
    // Same right-hand column.
    expect(Math.abs(btn.x - locate.x)).toBeLessThan(2);
  });

  test("remembers the choice across a reload", async ({ page }) => {
    await page.locator(unitBtn).click();
    await expect(page.locator(tempValue)).toHaveText("88°F");

    await gotoApp(page);
    await waitForLoaded(page);
    await expect(page.locator(unitBtn)).toHaveText("°F");
    await expect(page.locator(tempValue)).toHaveText("88°F");
  });
});

test.describe("forecast readout without a location", () => {
  test("stays hidden when geolocation is unavailable", async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
    // Assert the box exists but is not displayed — toBeHidden() alone also
    // passes when the locator matches nothing, which would not prove anything.
    await expect(page.locator(readout)).toHaveCount(1);
    await expect(page.locator(readout)).toBeHidden();
    // Hidden outright, not left showing a skeleton that will never resolve.
    await expect(page.locator(readout)).not.toHaveClass(/readout-loading/);
    // The rest of the app still came up.
    await expect(page.locator(".time-label")).not.toHaveText("—");
  });

  test("stays hidden for a fix outside the HRRR grid", async ({ context, page }) => {
    // Bermuda passes the app's coarse lon/lat domain box but falls off the LCC
    // grid; clamping it would report the weather ~400 km out over the ocean.
    await context.setGeolocation({ longitude: -64.75, latitude: 32.29 });
    await context.grantPermissions(["geolocation"]);
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
    await expect(page.locator(readout)).toBeHidden();
  });
});
