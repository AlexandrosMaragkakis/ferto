import { test, expect, type Page } from "@playwright/test";

async function expectResponsiveLayout(page: Page, width: number) {
  const [art, details, frame] = await Promise.all([
    page.locator(".art-frame").boundingBox(), page.locator(".track-details").boundingBox(),
    page.locator("#embed-frame").boundingBox(),
  ]);
  expect(art).not.toBeNull(); expect(details).not.toBeNull(); expect(frame).not.toBeNull();
  if (!art || !details || !frame) throw new Error("The recommendation layout is missing");
  if (width >= 1280) expect(art.x + art.width).toBeLessThanOrEqual(details.x + 1);
  else expect(art.y + art.height).toBeLessThanOrEqual(details.y + 1);
  expect(frame.height).toBe(80);

  const discs = await page.locator(".actions .action-disc").evaluateAll((elements) =>
    elements.map((element) => { const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height }; }));
  expect(discs).toHaveLength(3);
  for (const disc of discs) {
    expect(disc.width).toBeGreaterThanOrEqual(44);
    expect(disc.height).toBeGreaterThanOrEqual(44);
  }
  // Next may be larger, while all three controls still share one visual row.
  expect(Math.min(...discs.map((disc) => disc.y + disc.height)) - Math.max(...discs.map((disc) => disc.y))).toBeGreaterThan(0);
  const labelRows = await page.locator(".actions .action-label").evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().y));
  expect(Math.max(...labelRows) - Math.min(...labelRows)).toBeLessThanOrEqual(1);
  expect(discs[0].x + discs[0].width).toBeLessThanOrEqual(discs[1].x);
  expect(discs[1].x + discs[1].width).toBeLessThanOrEqual(discs[2].x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.beforeEach(async ({ page }) => {
  // The Worker and SQL are real and local. Embeds/artwork must never make the
  // suite depend on Spotify, external images, user credentials or live quotas.
  await page.route("https://**/*", (route) => route.abort());
});

test("public discovery works while owner-session discovery is stalled", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/owner/session", async route => {
    await pending;
    await route.fulfill({ json: { authenticated: false } });
  });
  try {
    await page.goto("/?owner=1");
    await expect(page.locator("#title")).not.toHaveText("Finding something good…");
    await expect(page.locator("#another")).toBeEnabled();
    release();
    await expect(page.getByRole("button", { name: "SIGN IN WITH SPOTIFY" })).toBeVisible();
  } finally { release(); }
});

test("static pages and API errors receive security headers and inline scripts are blocked", async ({ page, request }) => {
  const response = await page.goto("/");
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toContain("script-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-src https://open.spotify.com");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  const api = await request.post("/api/owner/like", { data: {} });
  expect(api.status()).toBeGreaterThanOrEqual(400);
  expect(api.headers()["x-content-type-options"]).toBe("nosniff");
  await page.evaluate(() => {
    document.documentElement.dataset.cspProbe = "blocked";
    const script = document.createElement("script");
    script.textContent = 'document.documentElement.dataset.cspProbe = "executed"';
    document.head.append(script);
  });
  expect(await page.locator("html").getAttribute("data-csp-probe")).toBe("blocked");
  await expect(page.locator("#another")).toBeEnabled();
});

test("a cross-site Spotify cancellation returns the browser cookie and consumes the real transaction", async ({ page, context }) => {
  await page.route("https://accounts.spotify.com/authorize**", route => {
    const state = new URL(route.request().url()).searchParams.get("state")!;
    const callback = new URL("/api/owner/callback", page.url());
    callback.search = new URLSearchParams({ state, error: "access_denied" }).toString();
    return route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
  await page.goto("/?owner=1");
  await expect(page.locator("#another")).toBeEnabled();
  await page.getByRole("button", { name: "SIGN IN WITH SPOTIFY" }).click();
  await page.waitForURL("**/api/owner/callback?**");
  await expect(page.locator("body")).toContainText("Spotify sign-in was cancelled");
  expect((await context.cookies()).filter(cookie => cookie.name === "ferto_oauth")).toHaveLength(0);
  await page.reload();
  await expect(page.locator("body")).toContainText("expired OAuth state");
});

test("public recommendations, next, keyboard control, theme persistence and viewport fit", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const width = testInfo.project.name === "mobile" ? 390 : 1280;
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await expect(page.locator("#title")).not.toHaveText("Finding something good…");
  await expect(page.locator("#another")).toBeEnabled();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator(".actions .action-label")).toHaveText(["Never again", "Next", "Add"]);
  await expectResponsiveLayout(page, width);
  const first = await page.locator("#open-track").getAttribute("href");
  await page.locator("#another").focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#open-track")).not.toHaveAttribute("href", first!);
  await expect(page.locator("#owner-panel")).toBeHidden();
  await expect(page.locator("#like")).toBeDisabled();
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.reload(); await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator("#another")).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 740 });
  await expectResponsiveLayout(page, 320);
  expect(errors).toEqual([]);
});

test("owner access stays protected on the real backend", async ({ page, request }) => {
  await page.goto("/?owner=1");
  await expect(page.getByRole("button", { name: "SIGN IN WITH SPOTIFY" })).toBeVisible();
  await expect(page.locator("#operational-history")).toBeHidden();
  expect((await request.get("/api/owner/history")).status()).toBe(401);
  expect((await request.post("/api/owner/never-again", { data: { spotify_id: "1234567890123456789012" } })).status()).toBeGreaterThanOrEqual(400);
});

test("owner sees saved progress, observed counts and history; a failed action retains the current card", async ({ page }) => {
  const longTitle = "The Unnecessarily Long Song Title That Still Deserves To Fit On A Phone (Extended Version)";
  const longAlbum = "VeryLongUnbrokenAlbumNameDesignedToExerciseNarrowScreenWrappingAndKeepSpotifyControlsVisible";
  const snapshot = { state: "waiting", phaseLabel: "Track enrichment", candidateCount: 3,
    waitReason: "quota", retrySource: "backoff", retryAt: Date.now() + 3600000,
    lastPublicationAt: Date.now() - 60000,
    progress: { seedScanComplete: 1, seedArtists: 12, seedArtistsDone: 3, publishedRecordings: 14, publishedArtists: 2 },
    requests: { tracks: { attempts: 40, succeeded: 39, failed: 1, rateLimited: 1 } } };
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: { authenticated: true, refresh: snapshot } }));
  await page.route("**/api/recommendation*", (route) => route.fulfill({ json: { recommendation: {
    spotify_id: "1234567890123456789012", title: longTitle,
    artists: [{ id: "fixture", name: "A Long Artist Name With Several Collaborators To Fit On A Small Screen" }],
    album_name: longAlbum, image_url: null, spotify_url: "https://open.spotify.com/track/1234567890123456789012",
  }, candidateCount: 3 } }));
  await page.route("**/api/owner/refresh", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/owner/like", (route) => route.fulfill({ status: 503, json: { error: "Fixture outage" } }));
  await page.route("**/api/owner/history", (route) => route.fulfill({ json: { history: [{
    started_at: Date.now(), outcome: "promoted", progress: { seedArtistsDone: 12, stagedRecordings: 80 },
    discoveriesPerRequest: 2, rows_read: 12345, rows_written: 345, db_queries: 100,
  }], activity: [], interruptions: [{ occurred_at: Date.now(), endpoint: "tracks", reason: "quota", retry_at: Date.now() + 3600000, retry_source: "backoff" }] } }));
  await page.goto("/?owner=1");
  await expect(page.locator("#refresh-status")).toContainText("Artists: 3/12 completed");
  await expect(page.locator("#refresh-status")).toContainText("Available already: 14 new recordings across 2 new artists");
  await expect(page.locator("#refresh-status")).toContainText("New discoveries last made available:");
  await expect(page.locator("#refresh-status")).toContainText("Observed refresh requests: 40");
  await expect(page.locator("#refresh-status")).toContainText("quota reset time unknown");
  await expect(page.locator("#like")).toBeEnabled();
  const title = await page.locator("#title").textContent();
  await page.locator("#like").click();
  await expect(page.locator("#status")).toContainText("could not confirm");
  await expect(page.locator("#status")).toContainText("still here");
  await expect(page.locator("#like")).toBeEnabled();
  await expect(page.locator("#title")).toHaveText(title!);
  await page.getByText("Refresh history and API activity", { exact: true }).click();
  await expect(page.locator("#history-content")).toContainText("12 artists completed");
  await expect(page.locator("#history-content")).toContainText("12,345 rows read");
  await expect(page.locator("#title")).toHaveText(longTitle);
  await expect(page.locator("#album")).toHaveText(longAlbum);
  await page.setViewportSize({ width: 320, height: 740 });
  await expectResponsiveLayout(page, 320);
  expect(await page.locator("#title, #artist, #album").evaluateAll((elements) =>
    elements.every((element) => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
  expect(await page.locator("#owner-panel").evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1)).toBe(true);
  expect(await page.locator("#history-content").evaluate((history) => history.scrollWidth <= history.clientWidth + 1)).toBe(true);
});

test("empty shelf and failed recommendation keep recovery controls usable", async ({ page }) => {
  let fail = false;
  await page.route("**/api/recommendation*", (route) => route.fulfill({ status: fail ? 503 : 200,
    json: fail ? { error: "Fixture outage" } : { recommendation: null, candidateCount: 0 } }));
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("check back soon");
  fail = true; await page.reload();
  await expect(page.locator("#title")).toHaveText("Couldn't reach the music.");
  await expect(page.locator("#another")).toHaveAccessibleName("Retry loading a recommendation");
  await expect(page.locator("#another")).toBeEnabled();
  await page.locator("#another").click();
  await expect(page.locator("#another")).toBeEnabled();
  fail = false;
  await page.locator("#another").click();
  await expect(page.locator("#status")).toContainText("check back soon");
  await expect(page.locator("#another")).toBeDisabled();
});

test("visitors can understand the owner controls and open the privacy explanation with the keyboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#action-help")).toContainText("Only the owner");
  await expect(page.locator("footer")).toContainText("Everyone can explore");
  await expect(page.locator("#like")).toBeDisabled();
  await expect(page.locator("#never")).toHaveAttribute("title", /Permanently exclude/);
  const summary = page.locator(".about summary");
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".about")).toHaveAttribute("open", "");
  await expect(page.locator(".about")).toContainText("Spotify receives those requests");
  expect(await summary.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("sharing crawlers receive an absolute image and canonical public URL without JavaScript", async ({ request }) => {
  const response = await request.get("/?owner=1");
  const html = await response.text();
  expect(html).not.toContain("__FERTO_PUBLIC_ORIGIN__");
  const image = /property="og:image" content="([^"]+)"/.exec(html)?.[1];
  const canonical = /rel="canonical" href="([^"]+)"/.exec(html)?.[1];
  expect(image).toBeTruthy(); expect(canonical).toBeTruthy();
  expect(new URL(image!).pathname).toBe("/social-preview.png");
  expect(new URL(image!).origin).toBe(new URL(canonical!).origin);
  expect(new URL(canonical!).pathname).toBe("/");
  expect(new URL(canonical!).search).toBe("");
  expect(html).toContain('name="twitter:card" content="summary_large_image"');
  expect((await request.get("/social-preview.png")).headers()["content-type"]).toContain("image/png");
});

for (const action of ["save", "refresh"] as const) {
  test(`an expired owner session during ${action} preserves the card and offers sign-in`, async ({ page }) => {
    await page.route("**/api/owner/session", route => route.fulfill({ json: { authenticated: true, refresh: { state: "idle" } } }));
    await page.route(`**/api/owner/${action === "save" ? "like" : "refresh"}`, route => route.fulfill({ status: 401, json: { error: "owner session invalid" } }));
    await page.goto("/?owner=1");
    await expect(page.locator("#like")).toBeEnabled();
    const title = await page.locator("#title").textContent();
    await page.locator(action === "save" ? "#like" : "#start-refresh").click();
    await expect(page.locator("#refresh-status")).toContainText("session has expired");
    await expect(page.locator("#sign-in")).toBeVisible();
    await expect(page.locator("#logout")).toBeHidden();
    await expect(page.locator("#like")).toBeDisabled();
    await expect(page.locator("#never")).toBeDisabled();
    await expect(page.locator("#title")).toHaveText(title!);
    await expect(page.locator("#another")).toBeEnabled();
  });
}

test("a stalled Spotify frame offers a retry without changing the song or losing its direct link", async ({ page }) => {
  let attempts = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("https://open.spotify.com/embed/track/**", async route => {
    attempts++;
    if (attempts === 1) {
      await pending;
      await route.abort().catch(() => undefined);
    } else await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Offline embed fixture</title>" });
  });
  try {
    await page.clock.install();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#another")).toBeEnabled();
    const track = await page.locator("#open-track").getAttribute("href");
    await page.clock.fastForward(10_001);
    await expect(page.locator("#embed-placeholder")).toContainText("hasn't loaded yet");
    await expect(page.locator("#retry-embed")).toBeVisible();
    await page.locator("#retry-embed").click();
    await expect(page.locator("#embed-placeholder")).toBeHidden();
    await expect(page.locator("#open-track")).toHaveAttribute("href", track!);
    expect(attempts).toBe(2);
    await expect(page.locator("#another")).toBeEnabled();
  } finally { release(); }
});

test("official Spotify logos render with the correct monochrome colour in both themes under CSP", async ({ page }) => {
  await page.goto("/");
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.getByRole("button", { name: "Switch to light theme" }).click();
    const logo = page.locator(theme === "dark" ? ".spotify-logo-dark" : ".spotify-logo-light");
    await expect(logo).toBeVisible();
    const brightness = await logo.evaluate(async element => {
      const image = element as HTMLImageElement;
      await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = 92; canvas.height = 26;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0, 92, 26);
      const rgba = ctx.getImageData(0, 0, 92, 26).data;
      let total = 0, pixels = 0;
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] > 200) { total += rgba[i]; pixels++; }
      if (!pixels) throw new Error("Spotify logo has no visible pixels");
      return total / pixels;
    });
    if (theme === "dark") expect(brightness).toBeGreaterThan(250);
    else expect(brightness).toBeLessThan(5);
    expect(await logo.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(70);
  }
});
