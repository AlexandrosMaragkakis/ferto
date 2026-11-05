import "./style.css";
import "./owner.css";
import { progressText, retryText, type ProgressSnapshot } from "./refresh-progress";
import { ArtworkTheme } from "./artwork-theme";
import type { OperationalHistory } from "../../src/operations";
import { fetchWithDeadline } from "../../src/request";

type Credit = { id: string; name: string };
type Recommendation = { spotify_id: string; title: string; artists: Credit[]; album_name: string; image_url: string | null; spotify_url: string };
type RecommendationResponse = { recommendation: Recommendation | null; candidateCount: number };
type RefreshStatus = ProgressSnapshot & {
  state?: "idle" | "active" | "waiting" | "failed";
  refreshId?: string | null;
  phase?: string | null;
  phaseLabel?: string | null;
  progress?: Record<string, number>;
  latestOutcome?: string | null;
  candidateCount?: number;
  warnings?: string[];
  nextRefreshAt?: number | null;
  lastPublicationAt?: number | null;
  error?: string;
  retryAfterSeconds?: number;
  retryAt?: number;
  retrySource?: "spotify" | "backoff";
  waitReason?: "rate_limit" | "quota" | "upstream";
};

// The current track plays through the official compact Spotify Embed; the
// anchor beside it is the canonical open.spotify.com fallback link.
const EMBED_URL = "https://open.spotify.com/embed/track/";
const TRACK_URL = "https://open.spotify.com/track/";
// Public copy stays friendly and never mentions refresh internals.
const EMPTY_MESSAGE = "Nothing here yet — check back soon for the next pick.";
const ONLY_PICK_MESSAGE = "That is the only song here right now — check back soon for more.";
// A failed owner action keeps the current card on screen.
const LIKE_FAILED_MESSAGE = "Spotify could not confirm this save just now — this song is still here. Try again.";
const NEVER_FAILED_MESSAGE = "Spotify could not confirm this song just now — it is still here. Try again.";
const ACTION_UNREACHABLE_MESSAGE = "That could not be confirmed — this song is still here. Try again.";
const SIGN_IN_FAILED_MESSAGE = "Sign-in could not start. Check your connection and try again.";
const SIGN_OUT_FAILED_MESSAGE = "Sign-out did not go through. Check your connection and try again.";
const REFRESH_START_FAILED_MESSAGE = "The catalogue refresh could not start. Try again.";
const SESSION_EXPIRED_MESSAGE = "Your owner session has expired. Sign in again to save or hide songs. You can keep browsing.";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const ownerMode = new URL(location.href).searchParams.get("owner") === "1";
const artworkTheme = new ArtworkTheme(document.documentElement);
let artworkRequest = 0;

let current: Recommendation | null = null;
let owner = false;
let refresh: RefreshStatus | null = null;
let pollTimer: number | undefined;
let emptyPollTimer: number | undefined;
let readyCandidateCount = 0;
let loadPending = false;
let actionPending = false;
let recommendationFailed = false;
let refreshPollFailures = 0;
let refreshStartPending = false;
let embedTimer: number | undefined;

function csrf(): string | undefined {
  const value = document.cookie.split("; ").find((item) => item.startsWith("ferto_csrf="))?.slice("ferto_csrf=".length);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.method && init.method !== "GET") headers.set("X-CSRF-Token", csrf() ?? "");
  const response = await fetchWithDeadline(path, { ...init, headers }, init?.method && init.method !== "GET" ? 40_000 : 15_000);
  if (owner && response.status === 401) expireOwnerSession();
  return response;
}

function message(text = "") {
  $("#status").textContent = text;
}

function refreshMessage(text = "") {
  $("#refresh-status").textContent = text;
}

/** Like/Never stay owner-only; controls disable while a request is in flight. */
function updateControls() {
  const actionEnabled = owner && current !== null && !actionPending;
  $("#never").toggleAttribute("disabled", !actionEnabled);
  $("#like").toggleAttribute("disabled", !actionEnabled);
  // A failed request leaves an explicit retry path even though the catalogue
  // size is unknown. Empty successful responses continue polling quietly.
  $("#another").toggleAttribute("disabled", loadPending || actionPending || (!recommendationFailed && readyCandidateCount === 0));
  $("#another .action-label").textContent = recommendationFailed ? "Retry" : "Next";
  $("#another").setAttribute("aria-label", recommendationFailed ? "Retry loading a recommendation" : "Show another recommendation");
  $("#action-help").textContent = owner
    ? "Add saves to your Liked Songs. Never again excludes this song from FERTO permanently."
    : "Next is for everyone. Only the owner can save or hide songs.";
}

function expireOwnerSession() {
  owner = false;
  refresh = null;
  window.clearTimeout(pollTimer);
  $("#owner-panel").hidden = false;
  $("#sign-in").hidden = false;
  $("#logout").hidden = true;
  $("#operational-history").hidden = true;
  refreshMessage(SESSION_EXPIRED_MESSAGE);
  message(SESSION_EXPIRED_MESSAGE);
  updateRefreshControl();
  updateControls();
}

function artistLine(item: Recommendation) {
  return item.artists.map((artist) => artist.name).join(", ");
}

function scheduleEmptyPoll(delay = 30_000) {
  window.clearTimeout(emptyPollTimer);
  if (!current && !readyCandidateCount) emptyPollTimer = window.setTimeout(() => void load(), delay);
}

function showArtwork(url: string | null, alt = "") {
  const request = ++artworkRequest;
  const previous = $<HTMLImageElement>("#art");
  // A fresh element isolates each request's load/error events. A late cover
  // cannot repaint the theme after Next has moved on to another song.
  const image = previous.cloneNode(false) as HTMLImageElement;
  const placeholder = $("#art-placeholder");
  const placeholderCopy = $("#art-placeholder-copy");
  // Never leave the previous cover visible while the next cover downloads:
  // that briefly pairs stale artwork with the new title and artist.
  image.hidden = true;
  image.removeAttribute("src");
  image.alt = "";
  placeholder.hidden = false;
  placeholder.setAttribute("aria-label", url ? "Artwork loading" : "Artwork unavailable");
  placeholderCopy.textContent = url ? "LOADING ARTWORK" : "ARTWORK UNAVAILABLE";
  const cached = url ? artworkTheme.cached(url) : null;
  artworkTheme.show(cached);
  previous.replaceWith(image);
  if (!url) return;
  let canSample = true;
  image.crossOrigin = "anonymous";
  image.addEventListener("load", () => {
    if (request !== artworkRequest || !image.isConnected) return;
    if (canSample && !cached) artworkTheme.sample(image, url);
    image.alt = alt;
    image.hidden = false;
    placeholder.hidden = true;
  });
  image.addEventListener("error", () => {
    if (request !== artworkRequest || !image.isConnected) return;
    artworkTheme.show(null);
    if (canSample) {
      // An image can be displayable even when its host disallows canvas
      // access. Retry without CORS and keep the neutral theme in that case.
      canSample = false;
      image.removeAttribute("crossorigin");
      image.src = url;
    } else {
      image.removeAttribute("src");
      placeholder.setAttribute("aria-label", "Artwork unavailable");
      placeholderCopy.textContent = "ARTWORK UNAVAILABLE";
    }
  });
  image.src = url;
}

function paint(item: Recommendation | null) {
  const section = $(".recommendation");
  section.setAttribute("aria-busy", "false");
  current = item;
  window.clearTimeout(embedTimer);
  if (!item) {
    showArtwork(null);
    $("#title").textContent = "All quiet for now.";
    $("#artist").textContent = "A new song will land here soon.";
    $("#album").textContent = "";
    $("#embed").hidden = true;
    $("#embed-placeholder").hidden = true;
    $<HTMLIFrameElement>("#embed-frame").removeAttribute("src");
    $("#open-track").setAttribute("href", "https://www.spotify.com/");
    updateControls();
    return;
  }
  showArtwork(item.image_url, `${item.album_name || item.title} cover art`);
  $("#title").textContent = item.title;
  $("#artist").textContent = artistLine(item);
  $("#album").textContent = item.album_name;
  showEmbed(item);
  updateControls();
}

function showEmbed(item: Recommendation) {
  window.clearTimeout(embedTimer);
  $("#embed").hidden = false;
  $("#embed-placeholder").hidden = false;
  $("#embed-placeholder").textContent = "LOADING SPOTIFY…";
  $<HTMLDetailsElement>("#embed-help").open = false;
  // Replace the iframe instead of navigating it in place: an iframe keeps
  // painting its previous document until the next one loads, which can pair
  // the old player with the new title after Next. A detached old frame can no
  // longer flash stale content, and the fresh frame appears only after load.
  const previousFrame = $<HTMLIFrameElement>("#embed-frame");
  const frame = previousFrame.cloneNode(false) as HTMLIFrameElement;
  // Keep the frame laid out so its navigation starts immediately. `hidden`
  // plus iframe lazy-loading can deadlock: no request, therefore no load event
  // to reveal it. Visibility conceals it while preserving its layout box.
  frame.hidden = false;
  frame.classList.add("embed-frame-loading");
  frame.removeAttribute("loading");
  frame.title = `Spotify Embed: ${item.title} — ${artistLine(item)}`;
  frame.addEventListener("load", () => {
    if (current?.spotify_id === item.spotify_id && frame.isConnected) {
      window.clearTimeout(embedTimer);
      frame.classList.remove("embed-frame-loading");
      $("#embed-placeholder").hidden = true;
    }
  });
  // Assign the destination while detached. In Chromium, inserting a src-less
  // iframe first emits an about:blank load and reveals a blank player early.
  frame.src = `${EMBED_URL}${encodeURIComponent(item.spotify_id)}?utm_source=generator`;
  previousFrame.replaceWith(frame);
  // Cross-origin frame contents cannot reliably reveal a blocked player.
  // Bound the loading message and keep help/direct listening available even
  // if a browser reports a load event for an error document.
  embedTimer = window.setTimeout(() => {
    if (frame.isConnected && current?.spotify_id === item.spotify_id) {
      $("#embed-placeholder").textContent = "Spotify hasn't loaded yet.";
      $<HTMLDetailsElement>("#embed-help").open = true;
    }
  }, 10_000);
  const trackUrl = item.spotify_url || `${TRACK_URL}${encodeURIComponent(item.spotify_id)}`;
  $("#open-track").setAttribute("href", trackUrl);
}

async function load(avoidRepeat = false) {
  if (loadPending) return;
  window.clearTimeout(emptyPollTimer);
  loadPending = true;
  updateControls();
  message(avoidRepeat ? "Finding another track…" : "Loading a recommendation…");
  $(".recommendation").setAttribute("aria-busy", "true");
  try {
    const exclude = avoidRepeat && current ? `?exclude=${encodeURIComponent(current.spotify_id)}` : "";
    const response = await api(`/api/recommendation${exclude}`);
    if (!response.ok) throw new Error("recommendation request failed");
    const body = await response.json() as RecommendationResponse;
    recommendationFailed = false;
    readyCandidateCount = body.candidateCount;
    if (avoidRepeat && current && !body.recommendation) {
      $(".recommendation").setAttribute("aria-busy", "false");
      message(ONLY_PICK_MESSAGE);
      scheduleEmptyPoll();
      return;
    }
    paint(body.recommendation);
    message(body.recommendation ? "" : EMPTY_MESSAGE);
    scheduleEmptyPoll();
  } catch {
    $(".recommendation").setAttribute("aria-busy", "false");
    recommendationFailed = true;
    if (!current) {
      $("#title").textContent = "Couldn't reach the music.";
      $("#artist").textContent = "Check your connection and try again.";
      showArtwork(null);
    }
    message("Could not load another track. Try again.");
    // Recover automatically from a transient first-load failure while keeping
    // Next enabled as an immediate manual retry.
    scheduleEmptyPoll(10_000);
  } finally {
    loadPending = false;
    updateControls();
  }
}

function refreshIsActive(snapshot = refresh) {
  return Boolean(snapshot?.refreshId && ["active", "waiting"].includes(snapshot.state ?? ""));
}

function updateRefreshControl() {
  const button = $<HTMLButtonElement>("#start-refresh");
  const canStart = owner && !refreshIsActive();
  button.hidden = !canStart;
  button.disabled = refreshStartPending;
  button.textContent = refreshStartPending ? "STARTING REFRESH…" : "REFRESH CATALOGUE";
}

function scheduleUtc(timestamp: number): string {
  const formatted = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(timestamp));
  return `${formatted} UTC`;
}

/** Owner area: start an idle refresh, then show phase, progress, warnings, and outcome. */
function showRefreshStatus(snapshot: RefreshStatus) {
  const warnings = snapshot.warnings?.length ? ` Warnings: ${snapshot.warnings.join("; ")}.` : "";
  const next = snapshot.nextRefreshAt ? ` Next scheduled refresh: ${scheduleUtc(snapshot.nextRefreshAt)}.` : "";
  const publication = snapshot.lastPublicationAt ? ` New discoveries last made available: ${scheduleUtc(snapshot.lastPublicationAt)}.` : "";
  if (snapshot.state === "failed") {
    const progress = progressText(snapshot);
    refreshMessage(`Refresh failed${snapshot.error ? ` — ${snapshot.error}` : ""}. ${progress ? `${progress}. ` : ""}You can retry now.${next}`);
  } else if (snapshot.state === "waiting") {
    const reason = snapshot.waitReason === "quota" ? "Spotify quota reached"
      : snapshot.waitReason === "upstream" ? "Spotify is temporarily unavailable" : "Rate-limited by Spotify";
    const retry = `${retryText(snapshot)}${snapshot.retryAt ? `; ${scheduleUtc(snapshot.retryAt)}` : ""}`;
    const progress = progressText(snapshot);
    const shelf = snapshot.candidateCount ? ` The existing catalogue remains available (${snapshot.candidateCount} tracks).` : "";
    refreshMessage(`${reason}. Progress is saved.\n${progress ? `${progress}\n` : ""}${retry}.${shelf}${publication}${warnings}${next}`);
  } else if (snapshot.state === "active") {
    const progress = progressText(snapshot);
    refreshMessage(`${snapshot.phaseLabel ?? "Refreshing"}…${progress ? `\n${progress}` : ""}${publication}${warnings}${next}`);
  } else if (snapshot.latestOutcome) {
    const progress = progressText(snapshot);
    refreshMessage(`Last refresh: ${snapshot.latestOutcome}, ${snapshot.candidateCount ?? 0} candidates on the shelf.${progress ? `\n${progress}` : ""}${warnings}${next}`);
  } else {
    refreshMessage(next.trim());
  }
  updateRefreshControl();
}

function schedulePoll(delay = 10_000) {
  window.clearTimeout(pollTimer);
  if (refresh?.state === "waiting" && (refresh.retryAfterSeconds ?? 0) > 60) delay = Math.max(delay, 60_000);
  if (owner && refreshIsActive()) pollTimer = window.setTimeout(() => void pollRefresh(), delay);
}

async function pollRefresh() {
  try {
    const response = await api("/api/owner/refresh");
    if (response.status === 401) return;
    if (!response.ok) throw new Error("refresh status failed");
    refresh = await response.json() as RefreshStatus;
    refreshPollFailures = 0;
    showRefreshStatus(refresh);
    schedulePoll();
  } catch {
    refreshPollFailures += 1;
    refreshMessage("Could not read refresh progress. Retrying while the background refresh continues.");
    schedulePoll(Math.min(60_000, 10_000 * (2 ** (refreshPollFailures - 1))));
  }
}

async function ownerState() {
  if (ownerMode) $("#owner-panel").hidden = false;
  const response = await api("/api/owner/session");
  if (!response.ok) throw new Error("owner session request failed");
  const session = await response.json() as { authenticated: boolean; refresh?: RefreshStatus | null };
  owner = session.authenticated;
  refresh = session.refresh ?? null;
  if (ownerMode) {
    $("#owner-panel").hidden = false;
    $("#sign-in").hidden = owner;
    $("#logout").hidden = !owner;
    $("#operational-history").hidden = !owner;
  }
  if (owner && refresh) {
    showRefreshStatus(refresh);
    if (refreshIsActive()) {
      // Opening the owner panel also repairs a lost local/Queue wake-up. The
      // backend re-sends the same durable generation and revision, so this is
      // idempotent and never creates overlapping rebuild work.
      try {
        const response = await api("/api/owner/refresh", { method: "POST" });
        if (response.ok) {
          refresh = await response.json() as RefreshStatus;
          showRefreshStatus(refresh);
        }
      } catch {
        // Status polling below remains a recovery path for a transient error.
      }
      schedulePoll();
    }
  }
  updateRefreshControl();
  updateControls();
}

/** One-click owner action: no confirmation, next recommendation on success, current card kept on failure. */
async function ownerAction(path: string, working: string, failure: string): Promise<void> {
  if (!current || actionPending) return;
  actionPending = true;
  updateControls();
  message(working);
  let succeeded = false;
  try {
    const response = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: current.spotify_id }) });
    succeeded = response.ok;
    message(succeeded ? "" : response.status === 401 ? SESSION_EXPIRED_MESSAGE : failure);
  } catch {
    message(ACTION_UNREACHABLE_MESSAGE);
  } finally {
    actionPending = false;
    updateControls();
  }
  // A failed Like or Never deliberately leaves the current card on screen;
  // only a successful action asks for the next recommendation.
  if (succeeded) await load();
}

$("#another").addEventListener("click", () => void load(true));
$("#retry-embed").addEventListener("click", () => { if (current) showEmbed(current); });
$("#like").addEventListener("click", () => void ownerAction("/api/owner/like", "Saving to your Spotify…", LIKE_FAILED_MESSAGE));
$("#never").addEventListener("click", () => void ownerAction("/api/owner/never-again", "Excluding this song…", NEVER_FAILED_MESSAGE));
$("#start-refresh").addEventListener("click", async () => {
  if (!owner || refreshIsActive() || refreshStartPending) return;
  refreshStartPending = true;
  updateRefreshControl();
  refreshMessage("Starting catalogue refresh…");
  try {
    const response = await api("/api/owner/refresh", { method: "POST" });
    if (response.status === 401) return;
    if (!response.ok) throw new Error("refresh start failed");
    refresh = await response.json() as RefreshStatus;
    refreshPollFailures = 0;
    showRefreshStatus(refresh);
    if (refreshIsActive()) schedulePoll(1_000);
  } catch {
    refreshMessage(REFRESH_START_FAILED_MESSAGE);
  } finally {
    refreshStartPending = false;
    updateRefreshControl();
  }
});
$("#sign-in").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("#sign-in");
  button.disabled = true;
  try {
    const response = await api("/api/owner/login", { method: "POST" });
    let body: { authorizeUrl?: string; error?: string };
    try {
      body = await response.json() as { authorizeUrl?: string; error?: string };
    } catch {
      message(SIGN_IN_FAILED_MESSAGE);
      return;
    }
    if (response.ok && body.authorizeUrl) location.assign(body.authorizeUrl);
    else message(body.error ?? SIGN_IN_FAILED_MESSAGE);
  } catch {
    message(SIGN_IN_FAILED_MESSAGE);
  } finally {
    button.disabled = false;
  }
});
$("#logout").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("#logout");
  button.disabled = true;
  try {
    const response = await api("/api/owner/logout", { method: "POST" });
    if (!response.ok) throw new Error("logout failed");
    location.assign("/");
  } catch {
    message(SIGN_OUT_FAILED_MESSAGE);
    button.disabled = false;
  }
});

function applyTheme(dark: boolean, persist = false) {
  document.documentElement.classList.toggle("dark", dark);
  $("#theme-toggle").setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`);
  artworkTheme.apply();
  if (persist) {
    try {
      localStorage.setItem("ferto-theme", dark ? "dark" : "light");
    } catch {
      // Theme switching still works when storage is unavailable.
    }
  }
}

$("#theme-toggle").addEventListener("click", () => applyTheme(!document.documentElement.classList.contains("dark"), true));
applyTheme(document.documentElement.classList.contains("dark"));

// Public discovery must not wait for authentication or owner status queries.
void ownerState().catch(() => {
  if (ownerMode) refreshMessage("Owner access could not be checked. Reload to try again, or keep exploring.");
});
void load();

$("#operational-history").addEventListener("toggle", async () => {
  if (!owner || !$("#operational-history").hasAttribute("open")) return;
  const content = $("#history-content");
  content.textContent = "Loading history…";
  try {
    const response = await api("/api/owner/history");
    if (response.status === 401) return;
    if (!response.ok) throw new Error("History unavailable");
    const history = await response.json() as OperationalHistory;
    content.textContent = history.history.length ? history.history.map((run) =>
      `${scheduleUtc(run.started_at)} · ${run.outcome}\n${run.progress.seedArtistsDone ?? 0} artists completed · ${run.progress.stagedRecordings ?? 0} distinct recordings staged\n${run.discoveriesPerRequest === null ? 'Discovery yield available after completion' : `${(100 * run.discoveriesPerRequest).toFixed(1)} new eligible discoveries per 100 data requests`}\nD1: ${run.rows_read.toLocaleString()} rows read · ${run.rows_written.toLocaleString()} rows written (${run.db_queries.toLocaleString()} queries)`
    ).join("\n\n") : "No refresh history yet.";
    const activity = history.activity.slice(0, 24).map((hour) =>
      `${scheduleUtc(hour.hour)}: ${Object.entries(hour.requests).map(([endpoint, counts]) => `${endpoint} ${counts.attempts} (${counts.failed} failed)`).join(', ')}`);
    if (activity.length) content.textContent += `\n\nRecent endpoint activity\n${activity.join('\n')}`;
    if (history.interruptions.length) content.textContent += `\n\nRecent rate/quota interruptions\n${history.interruptions.slice(0, 10).map((event) =>
      `${scheduleUtc(event.occurred_at)} · ${event.endpoint ?? 'data API'} · ${event.reason}; next attempt ${scheduleUtc(event.retry_at)} (${event.retry_source})`).join('\n')}`;
    content.textContent += "\n\nObserved totals may miss interrupted work. Stored D1 totals exclude final metric writes; public traffic is logged separately.";
  } catch { content.textContent = "History could not be loaded. Close and reopen to retry."; }
});
