import { expect, test } from "@playwright/test";
import { gotoApp, routeFixtures, waitForLoaded } from "./helpers.ts";

/**
 * Values the recorded fixtures hold for the geolocation below, at the pinned
 * init (see tests/fixtures/http/manifest.json). Only the leads in the
 * manifest's `pointLeads` are recorded, so the readout is asserted at exactly
 * those forecast hours.
 */
const DENVER = { longitude: -104.99, latitude: 39.74 };
const AT_0H = { temp: "31°C", dew: "10°C" };
const AT_30H = { temp: "33°C", dew: "4°C" };

const readout = ".readout";
const tempValue = ".readout-row:nth-child(1) .readout-value";
const dewValue = ".readout-row:nth-child(2) .readout-value";

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
    // Labelled for assistive tech rather than relying on the layout alone.
    await expect(page.locator(readout)).toHaveAttribute(
      "aria-label",
      "Forecast at your location",
    );
  });

  test("sits in the top-right corner, clear of the title", async ({ page }) => {
    const box = (await page.locator(readout).boundingBox())!;
    const viewport = page.viewportSize()!;
    // Right half, top quarter of the screen.
    expect(box.x).toBeGreaterThan(viewport.width / 2);
    expect(box.y).toBeLessThan(viewport.height / 4);
    // Below the legend chips it shares the top-right column with.
    const chips = (await page.locator(".chip-row").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(chips.y + chips.height);
  });

  test("updates when the timeline is scrubbed", async ({ page }) => {
    await expect(page.locator(tempValue)).toHaveText(AT_0H.temp);

    await page.locator(".scrubber").fill("30");
    await expect(page.locator(".rel-label")).toHaveText("+30h");

    await expect(page.locator(tempValue)).toHaveText(AT_30H.temp);
    await expect(page.locator(dewValue)).toHaveText(AT_30H.dew);
    // The readout must never blank out mid-scrub: it holds the previous
    // sample until the new one lands.
    await expect(page.locator(readout)).toBeVisible();
  });
});

test.describe("forecast readout without a location", () => {
  test("stays hidden when geolocation is unavailable", async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
    // Permission is not granted in this context, so there is no fix to sample.
    await expect(page.locator(readout)).toBeHidden();
    await expect(page.locator(".time-label")).not.toHaveText("—");
  });
});
