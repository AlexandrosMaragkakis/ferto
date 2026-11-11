import { test, expect, type Page } from "@playwright/test";
import { RECENT_HISTORY_KEY, type RecentTrack } from "../web/src/recent-history";

function track(index: number, recordingId = index.toString(16).padStart(64, "0")): RecentTrack {
  const id = String(index).padStart(22, "0");
  return { spotify_id: id, recordingId, title: `History song ${index}`, album_name: `Album ${index}`,
    artists: [{ id: "artist", name: "Fixture Artist" }], image_url: null, spotify_url: `https://open.spotify.com/track/${id}` };
}
async function mockOwner(page: Page, authenticated = false) {
  await page.route("**/api/owner/session", route => route.fulfill({ json: { authenticated } }));
  await page.route("**/api/owner/status", route => route.fulfill({ json: { state: "idle", candidateCount: 30 } }));
}
async function mockCards(page: Page, picks: RecentTrack[]) {
  const draws: string[] = [];
  await page.route("**/api/recommendation*", route => {
    draws.push(route.request().url());
    return route.fulfill({ json: { recommendation: picks[Math.min(draws.length - 1, picks.length - 1)], candidateCount: 30 } });
  });
  return draws;
}
async function expectCard(page: Page, item: RecentTrack) {
  await expect(page.locator("#title")).toHaveText(item.title);
  await expect(page.locator("#album")).toHaveText(item.album_name);
  await expect(page.locator("#open-track")).toHaveAttribute("href", item.spotify_url);
  await expect(page.locator("#embed-frame")).toHaveAttribute("src", `https://open.spotify.com/embed/track/${item.spotify_id}?utm_source=generator`);
}

test.beforeEach(async ({ page }) => {
  await page.route("https://**/*", route => route.abort());
});

test("keyboard Back and cached Next keep cards and player together before drawing again", async ({ page }) => {
  await mockOwner(page);
  const picks = [track(1), track(2), track(3), track(4)];
  const draws = await mockCards(page, picks);
  await page.goto("/");
  await expectCard(page, picks[0]);
  await expect(page.locator("#previous")).toBeDisabled();
  for (const item of picks.slice(1, 3)) {
    await page.locator("#another").click(); await expectCard(page, item);
  }
  await expect(page.getByRole("navigation", { name: "Recently shown tracks" })).toBeVisible();
  await expect(page.locator("#recent-position")).toHaveText("3 of 3 recently shown");
  await page.locator("#previous").focus();
  await page.keyboard.press("Enter"); await expectCard(page, picks[1]);
  await page.keyboard.press("Enter"); await expectCard(page, picks[0]);
  await expect(page.locator("#previous")).toBeDisabled();
  for (const item of picks.slice(1, 3)) {
    await page.locator("#another").click(); await expectCard(page, item);
  }
  expect(draws).toHaveLength(3);
  await page.locator("#another").click(); await expectCard(page, picks[3]);
  expect(draws).toHaveLength(4);
  expect(new URL(draws[3]).searchParams.get("exclude")).toBe(picks[2].spotify_id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await page.locator("#previous").boundingBox();
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
});

for (const action of ["like", "never-again"]) {
  test(`confirmed ${action} purges an upgraded legacy card and its canonical aliases`, async ({ page }) => {
    await mockOwner(page, true);
    const legacy = { ...track(1), recordingId: undefined };
    const alias = track(2, "a".repeat(64));
    const survivor = track(3);
    const draws = await mockCards(page, [legacy, alias, survivor]);
    await page.route(`**/api/owner/${action}`, async route => {
      expect(route.request().postDataJSON()).toEqual({ trackId: legacy.spotify_id });
      await route.fulfill({ json: { ok: true, recordingId: alias.recordingId } });
    });
    await page.goto("/"); await expectCard(page, legacy);
    for (const item of [alias, survivor]) {
      await page.locator("#another").click(); await expectCard(page, item);
    }
    await page.locator("#previous").click(); await expectCard(page, alias);
    await page.locator("#previous").click(); await expectCard(page, legacy);
    await page.locator(action === "like" ? "#like" : "#never").click();
    await expectCard(page, survivor);
    await expect(page.locator("#recent-position")).toHaveText("1 of 1 recently shown");
    await expect(page.locator("#previous")).toBeDisabled();
    expect(draws).toHaveLength(3);
    const stored = await page.evaluate(key => sessionStorage.getItem(key), RECENT_HISTORY_KEY);
    expect(stored).not.toContain(legacy.spotify_id);
    expect(stored).not.toContain(alias.spotify_id);
  });
}

for (const status of [502, 401]) {
  test(`unconfirmed owner action (${status}) keeps the card and both history directions`, async ({ page }) => {
    await mockOwner(page, true);
    const picks = [track(1), track(2), track(3)];
    const draws = await mockCards(page, picks);
    await page.route("**/api/owner/like", route => route.fulfill({ status, json: { error: "Fixture failure" } }));
    await page.goto("/"); await expectCard(page, picks[0]);
    for (const item of picks.slice(1)) {
      await page.locator("#another").click(); await expectCard(page, item);
    }
    await page.locator("#previous").click(); await expectCard(page, picks[1]);
    const before = await page.evaluate(key => sessionStorage.getItem(key), RECENT_HISTORY_KEY);
    await page.locator("#like").click();
    await expect(page.locator("#status")).toContainText(status === 401 ? "expired" : "still here");
    await expectCard(page, picks[1]);
    expect(await page.evaluate(key => sessionStorage.getItem(key), RECENT_HISTORY_KEY)).toBe(before);
    await page.locator("#previous").click(); await expectCard(page, picks[0]);
    await page.locator("#another").click(); await expectCard(page, picks[1]);
    await page.locator("#another").click(); await expectCard(page, picks[2]);
    expect(draws).toHaveLength(3);
    if (status === 401) await expect(page.locator("#like")).toBeDisabled();
  });
}

test("a pending draw locks actions; a failed draw retains navigation and a failed post-action draw cannot restore a removed card", async ({ page }) => {
  await mockOwner(page, true);
  const picks = [track(1), track(2)];
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/recommendation*", async route => {
    requests++;
    if (requests <= 2) return route.fulfill({ json: { recommendation: picks[requests - 1], candidateCount: 30 } });
    await held;
    return route.fulfill({ status: 503, json: { error: "Fixture offline" } });
  });
  await page.route("**/api/owner/never-again", route => route.fulfill({ json: { ok: true, recordingId: picks[1].recordingId } }));
  await page.goto("/"); await expectCard(page, picks[0]);
  await page.locator("#another").click(); await expectCard(page, picks[1]);
  await page.locator("#another").click();
  await expect.poll(() => requests).toBe(3);
  for (const selector of ["#another", "#previous", "#like", "#never"]) await expect(page.locator(selector)).toBeDisabled();
  release();
  await expect(page.locator("#status")).toContainText("Could not load another track");
  await expectCard(page, picks[1]);
  await page.locator("#previous").click(); await expectCard(page, picks[0]);
  await page.locator("#another").click(); await expectCard(page, picks[1]);
  expect(requests).toBe(3);
  await page.locator("#never").click();
  await expect.poll(() => requests).toBe(4);
  await expect(page.locator("#status")).toContainText("Could not load another track");
  await expect(page.locator("#title")).not.toHaveText(picks[1].title);
  await page.locator("#previous").click(); await expectCard(page, picks[0]);
  await expect(page.locator("#previous")).toBeDisabled();
});

test("history survives a same-tab reload and enforces the 20-card bound in the UI", async ({ page }) => {
  await mockOwner(page);
  const picks = Array.from({ length: 22 }, (_, index) => track(index + 1));
  const draws = await mockCards(page, picks);
  await page.goto("/"); await expectCard(page, picks[0]);
  for (const item of picks.slice(1)) {
    await page.locator("#another").click(); await expect(page.locator("#title")).toHaveText(item.title);
  }
  await expect(page.locator("#recent-position")).toHaveText("20 of 20 recently shown");
  await page.reload(); await expectCard(page, picks[21]);
  for (let index = 20; index >= 2; index--) {
    await page.locator("#previous").click(); await expect(page.locator("#title")).toHaveText(picks[index].title);
  }
  await expect(page.locator("#previous")).toBeDisabled();
  await expect(page.locator("#recent-position")).toHaveText("1 of 20 recently shown");
  expect(draws).toHaveLength(23);
});

test("blocked session storage still allows in-memory Back and Next", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("Fixture storage denial"); } }));
  await mockOwner(page);
  const picks = [track(1), track(2)];
  const draws = await mockCards(page, picks);
  await page.goto("/"); await expectCard(page, picks[0]);
  await page.locator("#another").click(); await expectCard(page, picks[1]);
  await page.locator("#previous").click(); await expectCard(page, picks[0]);
  await page.locator("#another").click(); await expectCard(page, picks[1]);
  expect(draws).toHaveLength(2);
});
