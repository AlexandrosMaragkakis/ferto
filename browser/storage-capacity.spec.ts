import { test, expect, type Page } from "@playwright/test";

const first = { spotify_id: "1234567890123456789012", recordingId: "a".repeat(64), title: "Capacity fixture one",
  artists: [{ id: "fixture", name: "Fixture artist" }], album_name: "Fixture album", image_url: null,
  spotify_url: "https://open.spotify.com/track/1234567890123456789012" };
const second = { ...first, spotify_id: "abcdefghijklmnopqrstuv", recordingId: "b".repeat(64), title: "Capacity fixture two",
  spotify_url: "https://open.spotify.com/track/abcdefghijklmnopqrstuv" };
const capacity = { bytes: 410_000_000, checkedAt: 1, paused: true, reason: "storage", warning: true,
  limitBytes: 500_000_000, warningBytes: 375_000_000, pauseBytes: 400_000_000, resumeBytes: 350_000_000 };

async function cards(page: Page) {
  let draws = 0;
  await page.route("**/api/recommendation*", route => route.fulfill({ json: { candidateCount: 2,
    recommendation: draws++ ? second : first } }));
}

test.beforeEach(async ({ page }) => {
  await page.route("https://**/*", route => route.abort());
  await cards(page);
});

test("a capacity pause is visible, preserves browsing and polls for recovery without waking growth", async ({ page }) => {
  await page.clock.install();
  let paused = true; let writes = 0; let polls = 0;
  const snapshot = () => ({ state: paused ? "paused" : "active", refreshId: "fixture-refresh", phaseLabel: "Track enrichment",
    candidateCount: 2, capacity: paused ? capacity : { ...capacity, bytes: 340_000_000, paused: false, reason: null, warning: false } });
  await page.route("**/api/owner/session", route => route.fulfill({ json: { authenticated: true, refresh: snapshot() } }));
  await page.route("**/api/owner/refresh", route => {
    if (route.request().method() === "POST") writes++; else polls++;
    return route.fulfill({ json: snapshot() });
  });
  await page.goto("/?owner=1");
  await expect(page.locator("#refresh-status")).toContainText("Discovery is paused");
  await expect(page.locator("#refresh-status")).toContainText("410.0 / 500 MB");
  await expect(page.locator("#start-refresh")).toBeHidden();
  await page.locator("#another").click();
  await expect(page.locator("#title")).toHaveText(second.title);
  expect(writes).toBe(0);
  paused = false;
  await page.clock.runFor(60001);
  await expect(page.locator("#refresh-status")).toContainText("Track enrichment");
  expect(polls).toBeGreaterThan(0);
  expect(writes).toBe(0);
});

test("a storage warning appears before growth is paused", async ({ page }) => {
  await page.route("**/api/owner/session", route => route.fulfill({ json: { authenticated: true,
    refresh: { state: "idle", candidateCount: 2, capacity: { ...capacity, bytes: 380_000_000, paused: false, reason: null } } } }));
  await page.goto("/?owner=1");
  await expect(page.locator("#refresh-status")).toContainText("380.0 / 500 MB");
  await expect(page.locator("#start-refresh")).toBeVisible();
});

test("a partial Spotify save preserves the card and history until local reconciliation is confirmed", async ({ page }) => {
  await page.route("**/api/owner/session", route => route.fulfill({ json: { authenticated: true } }));
  let reconciled = false;
  await page.route("**/api/owner/like", route => route.fulfill(reconciled
    ? { status: 200, json: { ok: true, recordingId: first.recordingId } }
    : { status: 202, json: { ok: false, spotifySaved: true, pending: true, error: "Saved to Spotify. FERTO will finish updating this song when storage is available." } }));
  await page.goto("/");
  await expect(page.locator("#like")).toBeEnabled();
  await page.locator("#another").click();
  await expect(page.locator("#title")).toHaveText(second.title);
  await page.locator("#previous").click();
  await page.locator("#like").click();
  await expect(page.locator("#title")).toHaveText(first.title);
  await expect(page.locator("#recent-position")).toHaveText("1 of 2 recently shown");
  await expect(page.locator("#status")).toContainText("Saved to Spotify");
  await expect(page.locator("#like")).toBeEnabled();
  reconciled = true;
  await page.locator("#like").click();
  await expect(page.locator("#title")).toHaveText(second.title);
  await expect(page.locator("#recent-position")).toHaveText("1 of 1 recently shown");
});

test("a full-database exclusion failure keeps the card available and explains the failure", async ({ page }) => {
  await page.route("**/api/owner/session", route => route.fulfill({ json: { authenticated: true } }));
  await page.route("**/api/owner/never-again", route => route.fulfill({ status: 503,
    json: { error: "Storage is full. Please try again later.", code: "storage" } }));
  await page.goto("/");
  await expect(page.locator("#never")).toBeEnabled();
  await page.locator("#never").click();
  await expect(page.locator("#title")).toHaveText(first.title);
  await expect(page.locator("#status")).toContainText("Storage is full");
  await expect(page.locator("#never")).toBeEnabled();
});
