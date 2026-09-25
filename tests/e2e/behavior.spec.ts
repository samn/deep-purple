import { expect, test } from "@playwright/test";
import { fixtureManifest, gotoApp, routeFixtures, waitForLoaded } from "./helpers.ts";

test.describe("playback", () => {
  test.beforeEach(async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
  });

  test("play advances the clock; pause stops it; scrubbing pauses", async ({ page }) => {
    const rel = page.locator(".rel-label");
    const playBtn = page.locator(".play-btn");
    await expect(rel).toHaveText("+0h");

    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Pause animation");
    await expect(rel).not.toHaveText("+0h", { timeout: 5000 });

    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Play animation");
    const frozen = await rel.textContent();
    await page.waitForTimeout(700);
    await expect(rel).toHaveText(frozen!);

    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Pause animation");
    await page.locator(".scrubber").fill("12");
    await expect(playBtn).toHaveAttribute("aria-label", "Play animation");
    await expect(rel).toHaveText("+12h");
  });

  test("autoplay starts once the first pass is loaded", async ({ context }) => {
    const page = await context.newPage();
    await gotoApp(page, "");
    await waitForLoaded(page);
    await expect(page.locator(".play-btn")).toHaveAttribute("aria-label", "Pause animation");
  });

  test("runs from the freshest init to the end of the spliced forecast", async ({ page }) => {
    // Hour 0 is the hourly 18-hour run's init — five hours ahead of the
    // six-hourly run in these fixtures — and the timeline reaches as far as the
    // six-hourly run's +48 h lands from there, which is short of +48.
    const init = new Date(fixtureManifest.initTimeMs).toISOString();
    expect(fixtureManifest.stores[0]!.initTimeIso).toBe(init);
    expect(fixtureManifest.stores[1]!.initTimeIso).not.toBe(init);
    expect(fixtureManifest.maxHours).toBeLessThan(48);

    await expect(page.locator(".scrubber")).toHaveAttribute(
      "max",
      String(fixtureManifest.maxHours),
    );
    // The axis is labelled for the range that exists, not a fixed 0–48.
    const ticks = await page.locator(".axis-tick").allTextContents();
    expect(ticks.at(-1)).toBe(`+${fixtureManifest.maxHours}h`);
    expect(ticks[0]).toBe("0h");

    // Scrubbing to the far end lands on the last hour that has frames, not on
    // a nominal +48 h the stores cannot serve.
    await page.locator(".scrubber").press("End");
    await expect(page.locator(".rel-label")).toHaveText(`+${fixtureManifest.maxHours}h`);
  });

  test("draws frames from both spliced stores", async ({ context }) => {
    // The hourly run covers 0–18 h and the six-hourly one carries the tail; if
    // the splice collapsed to one store, the map would either stop at +18 h or
    // lose the fresher nose it was introduced for.
    expect(fixtureManifest.stores.map((s) => s.frames)).toEqual([19, 25]);

    const hosts = new Set<string>();
    const page = await context.newPage();
    page.on("request", (req) => {
      const m = /noaa-hrrr-forecast-(18|48)-hour-virtual/.exec(req.url());
      if (m) hosts.add(m[1]!);
    });
    await gotoApp(page);
    await waitForLoaded(page);
    expect([...hosts].sort()).toEqual(["18", "48"]);
  });

  test("valid-time label reflects the forecast init time", async ({ page }) => {
    const init = new Date(fixtureManifest.initTimeMs);
    const expected = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "numeric",
      timeZone: "America/Denver",
    }).format(init);
    // ICU versions differ on the comma after the weekday; ignore it.
    const label = (await page.locator(".time-label").textContent())?.replace(",", "");
    expect(label).toBe(expected.replace(",", ""));
  });
});

test.describe("failure handling", () => {
  test("shows an error when the store is unreachable", async ({ context, page }) => {
    await context.route(
      (u) => u.hostname !== "localhost" && u.hostname !== "127.0.0.1",
      (route) => route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" }),
    );
    await page.goto("/?autoplay=0");
    await expect(page.locator(".status-error")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".status-error")).toContainText("Could not load forecast data");
  });
});

test.describe("geolocation", () => {
  test.use({
    geolocation: { longitude: -104.99, latitude: 39.74 },
    permissions: ["geolocation"],
  });

  test("centers the map on the user's location inside the HRRR domain", async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await page.waitForFunction(() => {
      const map = (window as unknown as { __map?: { getCenter(): { lng: number; lat: number } } }).__map;
      if (!map) return false;
      const c = map.getCenter();
      return Math.abs(c.lng - -104.99) < 0.5 && Math.abs(c.lat - 39.74) < 0.5;
    });
  });
});

test.describe("long-open tab", () => {
  test.beforeEach(async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
  });

  test("looks for a newer run when it comes back after a while, and moves the now tick", async ({ page }) => {
    const tick = page.locator(".now-tick");
    const before = await tick.evaluate((el) => (el as HTMLElement).style.left);
    const reopened = page.waitForRequest((r) => r.url().endsWith(".icechunk/repo"));

    // 20 minutes on, the tab returns to the foreground.
    await page.clock.setFixedTime(new Date(fixtureManifest.initTimeMs + 2 * 3_600_000 + 20 * 60_000));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

    await reopened;
    expect(await tick.evaluate((el) => (el as HTMLElement).style.left)).not.toBe(before);
    // The recorded stores haven't moved on, so nothing is offered.
    await page.waitForTimeout(1000);
    await expect(page.locator(".update-notice")).toHaveCount(0);
  });

  test("doesn't re-check right away", async ({ page }) => {
    let reopened = false;
    page.on("request", (r) => {
      if (r.url().endsWith(".icechunk/repo")) reopened = true;
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(1000);
    expect(reopened).toBe(false);
  });

  test("offers a newer run, and loads it on request", async ({ page }) => {
    await page.evaluate(() => {
      const worker = (window as unknown as { __worker: Worker }).__worker;
      worker.onmessage?.(new MessageEvent("message", { data: { type: "latest", newer: true } }));
    });
    const notice = page.locator(".update-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toContainText("Newer forecast available");
    await Promise.all([page.waitForEvent("load"), notice.getByRole("button", { name: "Update" }).click()]);
  });
});

test.describe("accessibility", () => {
  test.beforeEach(async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
  });

  test("the scrubber announces the forecast time, and both labels agree on it", async ({ page }) => {
    const slider = page.locator(".scrubber");
    // Past the half hour: the clock must round like "+Nh" does, not truncate.
    await slider.fill("5.6");
    await expect(page.locator(".rel-label")).toHaveText("+6h");
    const expected = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "numeric",
      timeZone: "America/Denver",
    }).format(new Date(fixtureManifest.initTimeMs + 6 * 3_600_000));
    const clock = (await page.locator(".time-label").textContent())!;
    expect(clock.replace(",", "")).toBe(expected.replace(",", ""));
    await expect(slider).toHaveAttribute("aria-valuetext", `${clock}, 6 hours ahead`);
  });

  test("status messages are announced", async ({ page }) => {
    await expect(page.locator(".status")).toHaveAttribute("role", "status");
  });

  test("says why locate did nothing when permission is off", async ({ page }) => {
    await page.locator(".locate-btn").click();
    await expect(page.locator(".status.status-visible")).toHaveText("Location permission is off for this site.");
    // It passes, rather than sitting over the map.
    await expect(page.locator(".status.status-visible")).toHaveCount(0, { timeout: 8000 });
  });
});

test.describe("locating outside the forecast area", () => {
  test.use({ geolocation: { longitude: -0.12, latitude: 51.5 }, permissions: ["geolocation"] });

  test("says so, and leaves the map where it was", async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
    await page.locator(".locate-btn").click();
    await expect(page.locator(".status.status-visible")).toHaveText(
      "Your location is outside the HRRR forecast area.",
    );
    const center = await page.evaluate(() =>
      (window as unknown as { __map: { getCenter(): { lng: number } } }).__map.getCenter(),
    );
    expect(center.lng).toBeCloseTo(-97.5, 0);
  });
});
