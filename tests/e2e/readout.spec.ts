import { expect, test } from "@playwright/test";
import { fixtureManifest, gotoApp, routeFixtures, waitForLoaded } from "./helpers.ts";

/**
 * The recorded fixtures only hold temperature/dew-point bodies for the leads in
 * the manifest's `pointLeads`, so the readout is asserted at exactly those
 * forecast hours. Values below are what the pinned init holds at DENVER; if you
 * re-record with `--fresh` they change and must be updated (there is no
 * snapshot to auto-refresh).
 */
const DENVER = { longitude: -104.99, latitude: 39.74 };
const [FIRST_LEAD, SCRUB_LEAD] = fixtureManifest.pointLeads;
const AT_FIRST = { temp: "31°C", dew: "10°C" };
const AT_SCRUB = { temp: "33°C", dew: "4°C" };

const readout = ".readout";
const tempValue = '.readout-metric[data-metric="temp"] .readout-value';
const dewValue = '.readout-metric[data-metric="dew"] .readout-value';
const unitBtn = ".unit-btn";

test.beforeEach(() => {
  // Guards the constants above against a fixture re-record that changes leads.
  expect(FIRST_LEAD).toBe(0);
  expect(SCRUB_LEAD).toBe(30);
});

test.describe("forecast readout with a location", () => {
  test.use({ geolocation: DENVER, permissions: ["geolocation"] });

  test.beforeEach(async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
  });

  test("shows temperature and dew point for the located point", async ({ page }) => {
    await expect(page.locator(readout)).toBeVisible();
    await expect(page.locator(tempValue)).toHaveText(AT_FIRST.temp);
    await expect(page.locator(dewValue)).toHaveText(AT_FIRST.dew);
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

  test("sits in the bottom bar, to the right of the time", async ({ page }) => {
    const box = (await page.locator(readout).boundingBox())!;
    const time = (await page.locator(".time-labels").boundingBox())!;
    const bar = (await page.locator(".bottom-bar").boundingBox())!;

    // Immediately right of the time labels, sharing their line.
    expect(box.x).toBeGreaterThanOrEqual(time.x + time.width);
    expect(box.x).toBeLessThan(time.x + time.width + 40);
    // Inside the bottom bar, not floating over the map.
    expect(box.y).toBeGreaterThanOrEqual(bar.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
    // Fits without pushing past the bar's padding, even at phone width.
    const viewport = page.viewportSize()!;
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    // The map controls are offset from the bottom by a fixed amount, so a
    // readout that wrapped to its own line would grow the bar underneath them.
    const info = (await page.locator(".maplibregl-ctrl-attrib-button").boundingBox())!;
    expect(info.y + info.height).toBeLessThanOrEqual(bar.y);
  });

  test("updates when the timeline is scrubbed", async ({ page }) => {
    await expect(page.locator(tempValue)).toHaveText(AT_FIRST.temp);

    await page.locator(".scrubber").fill(String(SCRUB_LEAD));
    await expect(page.locator(".rel-label")).toHaveText(`+${SCRUB_LEAD}h`);

    await expect(page.locator(tempValue)).toHaveText(AT_SCRUB.temp);
    await expect(page.locator(dewValue)).toHaveText(AT_SCRUB.dew);
    // Never blanks mid-scrub: it holds the previous sample until the new one
    // lands, rather than hiding while the fetch is in flight.
    await expect(page.locator(readout)).toBeVisible();
  });

  test("keeps a value on screen throughout autoplay", async ({ page }) => {
    // Autoplay is the production default, and playback walks the timeline past
    // leads with no recorded fixture — the readout must degrade to the nearest
    // sampled value rather than flicker or disappear.
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
