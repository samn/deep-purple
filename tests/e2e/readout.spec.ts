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
const tempValue = ".readout-row:nth-child(1) .readout-value";
const dewValue = ".readout-row:nth-child(2) .readout-value";

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

  test("sits against the top-right edge on any viewport", async ({ page }) => {
    const box = (await page.locator(readout).boundingBox())!;
    const viewport = page.viewportSize()!;
    // Flush right: its right edge is within the bar's own padding of the
    // viewport edge. Checked this way rather than "x > width/2" because the top
    // bar wraps on phones, where a half-width test says nothing about alignment.
    const rightGap = viewport.width - (box.x + box.width);
    expect(rightGap).toBeGreaterThanOrEqual(0);
    expect(rightGap).toBeLessThanOrEqual(24);
    // Top area, and clear of the chips it sits beneath.
    expect(box.y).toBeLessThan(viewport.height / 3);
    const chips = (await page.locator(".chip-row").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(chips.y + chips.height);
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
