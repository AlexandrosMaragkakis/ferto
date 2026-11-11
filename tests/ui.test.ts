import { describe, expect, it } from "vitest";
import indexHtml from "../web/index.html?raw";
import mainSource from "../web/src/main.ts?raw";
import styleSource from "../web/src/style.css?raw";
import ownerSource from "../web/src/owner.css?raw";
import themeBootstrap from "../web/public/theme-init.js?raw";

const uiSources = { indexHtml, mainSource, styleSource, ownerSource };

describe("FERTO interface", () => {
  describe("official compact Spotify embed", () => {
    it("ships the compact embed scaffold with an accessible name", () => {
      expect(indexHtml).toContain('<iframe');
      expect(indexHtml).toMatch(/<iframe\s[^>]*id="embed-frame"/);
      expect(indexHtml).toMatch(/<iframe\s[^>]*title="/);
      expect(indexHtml).toMatch(/<iframe\s[^>]*height="80"/);
      expect(indexHtml).toMatch(/<iframe\s[^>]*frameborder="0"/);
      expect(indexHtml).toContain('allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"');
      expect(mainSource).toContain('const EMBED_URL = "https://open.spotify.com/embed/track/');
    });

    it("keeps a canonical open.spotify.com track link fallback next to the embed", () => {
      expect(indexHtml).toMatch(/<a id="open-track"[^>]*target="_blank"/);
      expect(indexHtml).toMatch(/<a id="open-track"[^>]*rel="noreferrer"/);
      expect(mainSource).toContain('const TRACK_URL = "https://open.spotify.com/track/');
    });

    it("hides the embed until a recommendation arrives", () => {
      expect(indexHtml).toMatch(/<div id="embed"[^>]*hidden/);
    });

    it("replaces and hides the old iframe until the newly selected track loads", () => {
      expect(mainSource).toContain("previousFrame.cloneNode(false)");
      expect(mainSource).toContain("previousFrame.replaceWith(frame)");
      expect(mainSource).toContain('frame.classList.add("embed-frame-loading")');
      expect(mainSource).toContain('frame.addEventListener("load"');
      expect(mainSource).toContain('frame.classList.remove("embed-frame-loading")');
      expect(indexHtml).not.toContain('loading="lazy"');
      expect(mainSource.indexOf("frame.src =")).toBeLessThan(mainSource.indexOf("previousFrame.replaceWith(frame)"));
      expect(indexHtml).toContain('id="embed-placeholder"');
    });
  });

  describe("old playback surfaces are fully removed", () => {
    it("index.html carries no custom player controls or preview button", () => {
      expect(indexHtml).not.toContain('id="preview"');
      expect(indexHtml).not.toContain('class="player"');
      expect(indexHtml).not.toContain('id="progress"');
      expect(indexHtml).not.toContain('id="time"');
      expect(indexHtml).not.toContain("▶");
    });

    it("ships no Web Playback SDK, playback token, or custom audio wiring", () => {
      for (const source of Object.values(uiSources)) {
        const upper = source.toUpperCase();
        expect(upper).not.toContain("SDK.SCDN.SPOTIFY.COM");
        expect(upper).not.toContain("PLAYBACK");
        expect(upper).not.toContain("WEB PLAYBACK SDK");
      }
      expect(indexHtml).not.toContain("<audio");
      expect(mainSource).not.toContain("new Audio");
      expect(mainSource).not.toContain(".play(");
    });

    it("keeps player styling out of the stylesheets", () => {
      for (const css of [styleSource, ownerSource]) {
        expect(css).not.toMatch(/\.player\b/);
        expect(css).not.toMatch(/\.play\b/);
        expect(css).not.toMatch(/\.progress\b/);
        expect(css).not.toMatch(/\b\.time\b/);
      }
    });
  });

  describe("public empty state", () => {
    it("is friendly and exposes no refresh internals", () => {
      const empty = /EMPTY_MESSAGE = "([^"]*)"/.exec(mainSource)?.[1] ?? "";
      expect(empty).toBeTruthy();
      expect(empty).toMatch(/check back soon/i);
      expect(empty.toLowerCase()).not.toMatch(/candidat|shelf|refresh|generation|staging|queue|cron|schedule/);
    });

    it("keeps the only-pick follow-up equally free of internals", () => {
      const only = /ONLY_PICK_MESSAGE = "([^"]*)"/.exec(mainSource)?.[1] ?? "";
      expect(only).toBeTruthy();
      expect(only.toLowerCase()).not.toMatch(/candidat|shelf|refresh|generation|staging|queue|cron|schedule/);
    });
  });

  describe("one-click owner actions", () => {
    it("treats a malformed CSRF cookie as missing instead of crashing owner controls", () => {
      const helper = mainSource.slice(mainSource.indexOf("function csrf()"), mainSource.indexOf("async function api"));
      expect(helper).toContain("try {");
      expect(helper).toContain("decodeURIComponent(value)");
      expect(helper).toContain("catch {");
      expect(helper).toContain("return undefined;");
    });

    it("asks no confirmation and posts straight to the owner endpoints", () => {
      expect(mainSource).not.toContain("confirm(");
      expect(mainSource).toContain('ownerAction("/api/owner/like"');
      expect(mainSource).toContain('ownerAction("/api/owner/never-again"');
    });

    it("keeps actionable failure messages when owner writes fail", () => {
      // Failed-write preservation and confirmed-write navigation are exercised
      // against the running UI in browser/recent-history.spec.ts.
      const likeFailure = /LIKE_FAILED_MESSAGE = "([^"]*)"/.exec(mainSource)?.[1] ?? "";
      const neverFailure = /NEVER_FAILED_MESSAGE = "([^"]*)"/.exec(mainSource)?.[1] ?? "";
      // Both failures keep the current card on screen and say so.
      expect(likeFailure).toMatch(/still/i);
      expect(neverFailure).toMatch(/still/i);
    });

    it("disables Like and Never for visitors and while a request is in flight", () => {
      expect(mainSource).toContain("const actionEnabled = owner && current !== null && !actionPending && !loadPending;");
      expect(mainSource).toContain('$("#never").toggleAttribute("disabled", !actionEnabled);');
      expect(mainSource).toContain('$("#like").toggleAttribute("disabled", !actionEnabled);');
    });
  });

  describe("owner refresh area", () => {
    it("keeps the refresh trigger inside the initially hidden owner panel", () => {
      const panel = /<aside id="owner-panel"[\s\S]*?<\/aside>/.exec(indexHtml)?.[0] ?? "";
      expect(panel).toBeTruthy();
      expect(panel).toMatch(/<aside id="owner-panel"[^>]*hidden/);
      expect(panel.match(/<button/g) ?? []).toHaveLength(3);
      expect(panel).toMatch(/<button id="start-refresh"[^>]*hidden/);
      expect(panel).toContain('id="sign-in"');
      expect(panel).toContain('id="logout"');
      expect(panel.toUpperCase()).not.toContain("WAKE");
    });

    it("reads refresh status and lets an idle authenticated owner start it", () => {
      expect(mainSource).toContain('api("/api/owner/refresh")');
      expect(mainSource).toContain('api("/api/owner/refresh", { method: "POST" })');
      expect(mainSource).toContain("const canStart = owner && !refreshIsActive();");
      expect(mainSource).toContain("button.hidden = !canStart;");
      expect(mainSource).toContain("if (refreshIsActive()) schedulePoll(1_000);");
    });

    it("idempotently wakes active work when its owner panel opens", () => {
      expect(mainSource).toContain("Opening the owner panel also repairs a lost local/Queue wake-up");
      const ownerState = mainSource.slice(mainSource.indexOf("async function ownerState()"), mainSource.indexOf("async function ownerAction"));
      expect(ownerState).toContain('api("/api/owner/refresh", { method: "POST" })');
      expect(ownerState).toContain("if (refreshIsActive())");
      expect(ownerState).toContain("schedulePoll();");
    });

    it("surfaces phase, progress, outcome, warnings, and the next scheduled time", () => {
      for (const field of ["phaseLabel", "progressText", "latestOutcome", "warnings", "nextRefreshAt"]) {
        expect(mainSource).toContain(field);
      }
      expect(mainSource).toContain("Next scheduled refresh:");
      expect(mainSource).toContain("Last refresh:");
      expect(mainSource).toContain("timeZone: \"UTC\"");
    });

    it("keeps identity login and logout behavior", () => {
      expect(mainSource).toContain('"/api/owner/login"');
      expect(mainSource).toContain('"/api/owner/logout"');
      expect(indexHtml).toContain('id="sign-in"');
      expect(indexHtml).toContain('id="logout"');
    });

    it("guards sign-in against network and non-JSON failures and disables only while pending", () => {
      // The handler must surface a failed fetch or a non-JSON body instead of
      // raising an unhandled rejection, and must re-enable the button once the
      // request settles (including every early return).
      expect(mainSource).toContain('SIGN_IN_FAILED_MESSAGE = "');
      const handler = mainSource.slice(mainSource.indexOf('$("#sign-in").addEventListener'));
      expect(handler).toContain("button.disabled = true");
      expect(handler).toContain("button.disabled = false");
      expect(handler).toContain("try {");
      expect(handler).toContain("catch {");
      expect(handler).toContain("finally {");
    });
  });

  describe("accessible loading and error states", () => {
    it("keeps the live region, status roles, and aria-busy handling", () => {
      expect(indexHtml).toContain('aria-live="polite"');
      expect(indexHtml).toContain('aria-busy="true"');
      expect(indexHtml).toContain('id="status" class="status" role="status"');
      expect(indexHtml).toContain('id="refresh-status" class="refresh-status" role="status"');
      expect(mainSource).toContain('setAttribute("aria-busy", "true")');
      expect(mainSource).toContain('setAttribute("aria-busy", "false")');
    });

    it("announces loading and failure copy through the status line", () => {
      expect(mainSource).toContain("Could not load another track. Try again.");
      expect(mainSource).toContain("Loading a recommendation…");
    });

    it("keeps transient recommendation and refresh failures recoverable", () => {
      expect(mainSource).toContain("recommendationFailed = true;");
      expect(mainSource).toContain("scheduleEmptyPoll(10_000);");
      // Recommendation retry and cached forward navigation run in the browser suite.
      expect(mainSource).toContain("refreshPollFailures += 1;");
      expect(mainSource).toContain("schedulePoll(Math.min(60_000");
    });

    it("shows a deliberate fallback when Spotify artwork is absent or broken", () => {
      expect(indexHtml).toContain('id="art-placeholder"');
      expect(indexHtml).toContain('id="art-placeholder-copy"');
      expect(mainSource).toContain('placeholderCopy.textContent = url ? "LOADING ARTWORK" : "ARTWORK UNAVAILABLE"');
      expect(mainSource).toContain("function showArtwork(");
      expect(mainSource).toContain('addEventListener("load"');
      // Actual failed-image recovery and CORS fallback run in browser checks.
    });
  });

  describe("theme and responsive shell", () => {
    it("keeps a saved theme and an accessible theme control when storage is restricted", () => {
      expect(indexHtml).toContain('id="theme-color"');
      expect(indexHtml).toContain('<script src="/theme-init.js"></script>');
      expect(themeBootstrap).toMatch(/try\s*\{[\s\S]*localStorage\.getItem\("ferto-theme"\)[\s\S]*\}\s*catch/);
      expect(mainSource).toContain("function applyTheme(");
      expect(mainSource).toContain('setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`)');
      expect(mainSource).toMatch(/try\s*\{[\s\S]*localStorage\.setItem\("ferto-theme"[\s\S]*\}\s*catch/);
    });

    it("keeps one main area and accessible header and song actions", () => {
      const header = /<header class="topbar">([\s\S]*?)<\/header>/.exec(indexHtml)?.[1] ?? "";
      expect(indexHtml.match(/<main\b/g)).toHaveLength(1);
      expect(header).toContain('aria-label="FERTO home"');
      expect(header).toContain('aria-label="Owner access"');
      expect(header).toContain('id="theme-toggle"');
      expect(indexHtml).toContain('aria-label="Never recommend this track again"');
      expect(indexHtml).toContain('aria-label="Save this track to Spotify"');
    });
  });
});
