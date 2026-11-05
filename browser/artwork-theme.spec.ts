import { test, expect, type Page, type Route } from "@playwright/test";

const ART_ORIGIN = "https://artwork.example.test";
const RED_ART = `${ART_ORIGIN}/red.svg`;
const BLUE_ART = `${ART_ORIGIN}/blue.svg`;
const PALETTE_STORAGE = "ferto-artwork-palettes-v1";

type Pick = {
  spotify_id: string;
  title: string;
  artists: { id: string; name: string }[];
  album_name: string;
  image_url: string | null;
  spotify_url: string;
};

function pick(title: string, artwork: string | null, index: number): Pick {
  const id = `theme${String(index).padStart(17, "0")}`;
  return { spotify_id: id, title, artists: [{ id: "artist", name: "Fixture Artist" }],
    album_name: `${title} album`, image_url: artwork, spotify_url: `https://open.spotify.com/track/${id}` };
}

function cover(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`;
}

async function artworkResponse(route: Route, color: string, allowCors = true): Promise<void> {
  await route.fulfill({ contentType: "image/svg+xml", body: cover(color),
    // Playwright supplies permissive CORS headers when this is omitted, so a
    // different allowed origin is needed to exercise the browser's rejection.
    headers: { "access-control-allow-origin": allowCors ? "*" : "https://another-origin.example.test" } });
}

async function mockPicks(page: Page, picks: Pick[]): Promise<void> {
  let index = 0;
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.route("**/api/recommendation*", (route) => route.fulfill({ json: {
    recommendation: picks[Math.min(index++, picks.length - 1)], candidateCount: picks.length,
  } }));
}

async function palette(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    return { color: root.dataset.artworkColor,
      paper: styles.getPropertyValue("--paper").trim(), panel: styles.getPropertyValue("--panel").trim(),
      ink: styles.getPropertyValue("--ink").trim(), muted: styles.getPropertyValue("--muted").trim(),
      accent: styles.getPropertyValue("--accent").trim(), accentInk: styles.getPropertyValue("--accent-ink").trim() };
  });
}

async function expectArtworkPalette(page: Page, title: string): Promise<void> {
  await expect(page.locator("#title")).toHaveText(title);
  await expect(page.locator("#art")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-artwork-color", /^#[\da-f]{6}$/i);
}

test.beforeEach(async ({ page }) => {
  // Both palettes are reproducible and offline. Spotify's own player is never
  // replaced by a themed imitation, and the suite never calls Spotify.
  await page.route("https://**/*", async (route) => {
    if (route.request().url() === RED_ART) await artworkResponse(route, "#d52f45");
    else if (route.request().url() === BLUE_ART) await artworkResponse(route, "#2259ce");
    else await route.abort();
  });
});

test("cover colours change the surrounding UI while the native embed and layout remain intact", async ({ page }) => {
  const red = pick("Red song", RED_ART, 1);
  const blue = pick("Blue song", BLUE_ART, 2);
  await mockPicks(page, [red, blue]);
  await page.goto("/");
  await expectArtworkPalette(page, red.title);
  const redPalette = await palette(page);
  expect(Object.values(redPalette).every(Boolean)).toBe(true);
  await expect(page.locator("#embed-frame")).toHaveAttribute("src",
    `https://open.spotify.com/embed/track/${red.spotify_id}?utm_source=generator`);

  await page.locator("#another").click();
  await expectArtworkPalette(page, blue.title);
  const bluePalette = await palette(page);
  expect(bluePalette.color).not.toBe(redPalette.color);
  expect(bluePalette.paper).not.toBe(redPalette.paper);
  expect(bluePalette.panel).not.toBe(redPalette.panel);
  expect(bluePalette.accent).not.toBe(redPalette.accent);
  await expect(page.locator("#embed-frame")).toHaveAttribute("src",
    `https://open.spotify.com/embed/track/${blue.spotify_id}?utm_source=generator`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("an artwork palette survives reload and keeps its hue when switching light and dark", async ({ page }) => {
  // The app now defaults to dark. Start this one flow from an explicit light
  // preference and leave later reloads free to test the saved dark selection.
  await page.addInitScript(() => {
    if (!localStorage.getItem("ferto-theme")) localStorage.setItem("ferto-theme", "light");
  });
  await mockPicks(page, [pick("Cached red song", RED_ART, 1)]);
  await page.goto("/");
  await expectArtworkPalette(page, "Cached red song");
  const light = await palette(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), PALETTE_STORAGE)).toContain(RED_ART);

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const dark = await palette(page);
  expect(dark.color).toBe(light.color);
  expect(dark.paper).not.toBe(light.paper);
  expect(dark.ink).not.toBe(light.ink);

  await page.reload();
  await expectArtworkPalette(page, "Cached red song");
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await palette(page)).toEqual(dark);
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  expect(await palette(page)).toEqual(light);
});

test("missing and broken covers restore the neutral theme and leave Next usable", async ({ page }) => {
  await mockPicks(page, [pick("No artwork yet", null, 1), pick("Red song", RED_ART, 2),
    pick("Missing artwork", null, 3), pick("Broken artwork", `${ART_ORIGIN}/broken.svg`, 4),
    pick("Blue recovery", BLUE_ART, 5)]);
  await page.goto("/");
  await expect(page.locator("#title")).toHaveText("No artwork yet");
  const neutral = await palette(page);
  expect(neutral.color).toBeUndefined();
  await page.locator("#another").click();
  await expectArtworkPalette(page, "Red song");

  for (const title of ["Missing artwork", "Broken artwork"]) {
    await page.locator("#another").click();
    await expect(page.locator("#title")).toHaveText(title);
    await expect(page.locator("#art-placeholder-copy")).toHaveText("ARTWORK UNAVAILABLE");
    await expect(page.locator("#art")).toBeHidden();
    expect(await palette(page)).toEqual(neutral);
    await expect(page.locator("#another")).toBeEnabled();
  }
  await page.locator("#another").click();
  await expectArtworkPalette(page, "Blue recovery");
});

test("a cover without CORS permission is still displayed using the neutral theme", async ({ page }) => {
  const denied = `${ART_ORIGIN}/no-cors.svg`;
  await page.route(denied, (route) => artworkResponse(route, "#269557", false));
  await mockPicks(page, [pick("Red song", RED_ART, 1), pick("Display only cover", denied, 2)]);
  await page.goto("/");
  await expectArtworkPalette(page, "Red song");
  const red = await palette(page);
  await page.locator("#another").click();
  await expect(page.locator("#title")).toHaveText("Display only cover");
  await expect(page.locator("#art")).toBeVisible();
  await expect(page.locator("#art")).toHaveAttribute("src", denied);
  expect(await page.locator("#art").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64);
  expect((await palette(page)).color).toBeUndefined();
  expect((await palette(page)).paper).not.toBe(red.paper);
  await expect(page.locator("#another")).toBeEnabled();
});

test("a late previous cover cannot overwrite the current cover or colour after Next", async ({ page }) => {
  const slowArt = `${ART_ORIGIN}/slow-red.svg`;
  let startRoute!: () => void;
  const routeStarted = new Promise<void>((resolve) => { startRoute = resolve; });
  let releaseCover!: () => void;
  const coverGate = new Promise<void>((resolve) => { releaseCover = resolve; });
  let finishRoute!: () => void;
  const routeFinished = new Promise<void>((resolve) => { finishRoute = resolve; });
  await page.route(slowArt, async (route) => {
    startRoute();
    await coverGate;
    // The browser may cancel the old image as soon as the next track arrives.
    try { await artworkResponse(route, "#d52f45"); } catch { /* Cancelled old cover. */ }
    finally { finishRoute(); }
  });
  await mockPicks(page, [pick("Slow red song", slowArt, 1), pick("Current blue song", BLUE_ART, 2)]);
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#title")).toHaveText("Slow red song");
    await routeStarted;
    await page.locator("#another").click();
    await expectArtworkPalette(page, "Current blue song");
    const blue = await palette(page);
    releaseCover();
    await routeFinished;
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#art")).toHaveAttribute("src", BLUE_ART);
    await expect(page.locator("#title")).toHaveText("Current blue song");
    expect(await palette(page)).toEqual(blue);
  } finally { releaseCover(); }
});

test("unavailable palette storage does not prevent artwork, theming or the next recommendation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((paletteKey) => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === paletteKey) throw new DOMException("Storage unavailable", "SecurityError");
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === paletteKey) throw new DOMException("Storage full", "QuotaExceededError");
      setItem.call(this, key, value);
    };
  }, PALETTE_STORAGE);
  await mockPicks(page, [pick("Red song", RED_ART, 1), pick("Blue song", BLUE_ART, 2)]);
  await page.goto("/");
  await expectArtworkPalette(page, "Red song");
  const red = await palette(page);
  await page.locator("#another").click();
  await expectArtworkPalette(page, "Blue song");
  expect((await palette(page)).paper).not.toBe(red.paper);
  expect(errors).toEqual([]);
});
