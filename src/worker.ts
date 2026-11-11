import { observedInvocation, operationalHistory } from "./operations";
import { isTrackId, normalizeIsrc, ownerSessionMatches, recordingKey } from "./domain";
import { DAY, cookie, hmacSha256, isSameOrigin, parseCookies, randomToken, sha256, sha256Base64Url } from "./security";
import { consumeRefreshQueue, removeFromRecommendationPool, scheduledTick, startOrWakeRebuild, statusSnapshot, type RefreshMessage } from "./rebuild";
import { refreshSpotifyAccessToken } from "./spotify";
import { fetchWithDeadline } from "./request";
import { jsonObject, RequestError, secureResponse } from "./http-security";
import { cleanupRequestState, requestBudget } from "./request-budget";

const SESSION_TTL = 7 * DAY;
const OAUTH_TTL = 10 * 60 * 1000;
const json = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const error = (message: string, status: number) => json({ error: message }, status);
const now = () => Date.now();
const production = (env: Env) => new URL(env.APP_ORIGIN).protocol === "https:";
const log = (event: string, fields: Record<string, string | number | boolean> = {}) => console.log(JSON.stringify({ event, ...fields }));
const configured = (value: string | undefined) => Boolean(value && !value.startsWith("REPLACE_WITH_"));

function csrfHeader(request: Request, env: Env): HeadersInit { return parseCookies(request.headers.get("Cookie")).ferto_csrf ? {} : { "Set-Cookie": cookie("ferto_csrf", randomToken(), production(env), false, 7 * 24 * 60 * 60) }; }
async function requireMutationProtection(request: Request, env: Env): Promise<Response | null> { if (!isSameOrigin(request, env.APP_ORIGIN)) return error("cross-origin request rejected", 403); const csrf = parseCookies(request.headers.get("Cookie")).ferto_csrf; return csrf && csrf === request.headers.get("X-CSRF-Token") ? null : error("CSRF validation failed", 403); }
async function requireOwner(request: Request, env: Env): Promise<Response | null> { const session = parseCookies(request.headers.get("Cookie")).ferto_session; if (!session) return error("owner sign-in required", 401); const row = await env.DB.prepare("SELECT spotify_account_id FROM owner_sessions WHERE session_hash = ? AND expires_at > ?").bind(await hmacSha256(session, env.SESSION_SECRET), now()).first<{ spotify_account_id: string }>(); return ownerSessionMatches(row?.spotify_account_id, env.OWNER_SPOTIFY_ID) ? null : error("owner session invalid", 401); }

type SpotifyAccessToken = { access_token: string; expires_in: number; scope: string };
async function spotifyAccessToken(env: Env, refreshToken: string): Promise<SpotifyAccessToken> {
  const response = await refreshSpotifyAccessToken(env, refreshToken);
  if (!response.ok) throw new Error(`Spotify token refresh failed (${response.status})`);
  const body = await response.json<{ access_token?: unknown; expires_in?: unknown; scope?: unknown }>();
  if (typeof body.access_token !== "string") throw new Error("Spotify returned malformed token response");
  return { access_token: body.access_token, expires_in: typeof body.expires_in === "number" ? body.expires_in : 0, scope: typeof body.scope === "string" ? body.scope : "" };
}

type PublicCredit = { id: string; name: string };
type PublicRecommendation = {
  spotify_id: string;
  recordingId: string;
  title: string;
  artists: PublicCredit[];
  album_name: string;
  image_url: string | null;
  spotify_url: string;
};
type LiveRecordingRow = Omit<PublicRecommendation, "artists" | "recordingId"> & { artists_json: string; recording_key: string };
type LiveShelfState = { live_generation: string | null; candidate_count: number; live_bucket_count: number };
type ExcludedPoolSlot = { bucket_artist_id: string; bucket_slot: number; track_slot: number; track_count: number };
type PoolRecordingRow = LiveRecordingRow & { recording_key: string; excluded: number };

async function toPublic(row: LiveRecordingRow): Promise<PublicRecommendation> {
  let artists: PublicCredit[] = [];
  try {
    const parsed = JSON.parse(row.artists_json) as unknown;
    if (Array.isArray(parsed)) artists = parsed.filter((credit): credit is PublicCredit => Boolean(credit && typeof credit === "object" && typeof (credit as PublicCredit).id === "string" && typeof (credit as PublicCredit).name === "string"));
  } catch {
    artists = [];
  }
  return { spotify_id: row.spotify_id, recordingId: await sha256(row.recording_key), title: row.title, artists, album_name: row.album_name, image_url: row.image_url, spotify_url: row.spotify_url };
}

async function liveShelfState(env: Env): Promise<LiveShelfState> {
  return (await env.DB.prepare(
    "SELECT live_generation, candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1",
  ).first<LiveShelfState>()) ?? { live_generation: null, candidate_count: 0, live_bucket_count: 0 };
}

function drawSlot(count: number, skippedSlot?: number): number {
  const available = skippedSlot ? count - 1 : count;
  let slot = Math.floor(Math.random() * available) + 1;
  if (skippedSlot && slot >= skippedSlot) slot += 1;
  return slot;
}

async function recommendation(request: Request, env: Env): Promise<Response> {
  const requestedExclude = new URL(request.url).searchParams.get("exclude");
  // The visitor may only steer away from the representative currently shown;
  // recording keys and refresh internals never enter the request or response.
  const excludedId = requestedExclude && isTrackId(requestedExclude) ? requestedExclude : null;
  // Dense integer slots make the draw exact and bounded: one state row, one
  // artist row, and one track row. No public request scans the live shelf.
  // Three repairs keep the worst valid-exclude request at 37 D1 statements,
  // leaving real headroom below the Free-plan 50-query invocation ceiling.
  // If more stale slots exist, the next public request continues cleanup.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await liveShelfState(env);
    const live = state.live_generation;
    if (!live || state.candidate_count === 0 || state.live_bucket_count === 0) {
      return json({ recommendation: null, candidateCount: 0 }, 200, csrfHeader(request, env));
    }
    const excluded = excludedId
      ? await env.DB.prepare(
        `SELECT s.bucket_artist_id, s.track_slot, b.bucket_slot, b.track_count
         FROM recordings r
         JOIN recommendation_slots s ON s.generation = r.generation AND s.recording_key = r.recording_key
         JOIN recommendation_buckets b ON b.generation = s.generation AND b.bucket_artist_id = s.bucket_artist_id
         WHERE r.generation = ? AND r.spotify_id = ? LIMIT 1`,
      ).bind(live, excludedId).first<ExcludedPoolSlot>()
      : null;
    if (state.candidate_count - (excluded ? 1 : 0) <= 0) {
      return json({ recommendation: null, candidateCount: state.candidate_count }, 200, csrfHeader(request, env));
    }
    const skippedBucketSlot = excluded?.track_count === 1 ? excluded.bucket_slot : undefined;
    if (state.live_bucket_count - (skippedBucketSlot ? 1 : 0) <= 0) {
      return json({ recommendation: null, candidateCount: state.candidate_count }, 200, csrfHeader(request, env));
    }
    const bucketSlot = drawSlot(state.live_bucket_count, skippedBucketSlot);
    const bucket = await env.DB.prepare(
      "SELECT bucket_artist_id, track_count FROM recommendation_buckets WHERE generation = ? AND bucket_slot = ?",
    ).bind(live, bucketSlot).first<{ bucket_artist_id: string; track_count: number }>();
    if (!bucket) continue;
    const skippedTrackSlot = excluded?.bucket_artist_id === bucket.bucket_artist_id ? excluded.track_slot : undefined;
    const trackSlot = drawSlot(bucket.track_count, skippedTrackSlot);
    const row = await env.DB.prepare(
      `SELECT r.recording_key, r.spotify_id, r.title, r.album_name, r.image_url, r.spotify_url, r.artists_json,
              CASE WHEN EXISTS (
                     SELECT 1 FROM never_recordings n
                     WHERE n.recording_key = r.recording_key
                        OR n.spotify_id = r.spotify_id
                        OR (n.isrc IS NOT NULL AND n.isrc = r.isrc)
                   )
                     OR EXISTS (SELECT 1 FROM rebuild_known_recordings k WHERE k.generation = r.generation AND k.recording_key = r.recording_key)
                   THEN 1 ELSE 0 END AS excluded
       FROM recommendation_slots s
       JOIN recordings r ON r.generation = s.generation AND r.recording_key = s.recording_key
       WHERE s.generation = ? AND s.bucket_artist_id = ? AND s.track_slot = ?`,
    ).bind(live, bucket.bucket_artist_id, trackSlot).first<PoolRecordingRow>();
    if (!row) continue;
    if (row.excluded) {
      // External Spotify changes discovered during a long bootstrap can make
      // a slot stale briefly. Compact it lazily and retry without a scan.
      await removeFromRecommendationPool(env, live, row.recording_key);
      continue;
    }
    return json({ recommendation: await toPublic(row), candidateCount: state.candidate_count }, 200, csrfHeader(request, env));
  }
  const state = await liveShelfState(env);
  return json({ recommendation: null, candidateCount: state.candidate_count }, 200, csrfHeader(request, env));
}

async function ownerSession(request: Request, env: Env): Promise<Response> {
  const unauthorized = await requireOwner(request, env);
  return json({ authenticated: !unauthorized, refresh: unauthorized ? null : await statusSnapshot(env) }, 200, csrfHeader(request, env));
}
const oauthCookie = (value: string, env: Env, maxAge = OAUTH_TTL / 1000) =>
  cookie("ferto_oauth", value, production(env), true, maxAge, { path: "/api/owner/callback", sameSite: "Lax" });

async function login(request: Request, env: Env): Promise<Response> {
  const blocked = await requireMutationProtection(request, env);
  if (blocked) return blocked;
  if (!configured(env.SPOTIFY_CLIENT_ID) || !configured(env.OWNER_SPOTIFY_ID)) return error("owner sign-in is not configured", 503);
  if (!await requestBudget(request, env, "login")) return json({ error: "too many sign-in attempts; try again shortly" }, 429, { "Retry-After": "60" });
  const state = randomToken(), verifier = randomToken(64), browser = randomToken();
  const timestamp = now();
  const browserHash = await hmacSha256(browser, env.SESSION_SECRET);
  // Cleanup and admission share one transaction. Even distributed callers
  // cannot exceed the fixed outstanding-transaction cap.
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE expires_at <= ? ORDER BY expires_at LIMIT 128)").bind(timestamp),
    env.DB.prepare(`INSERT INTO oauth_states (state_hash, code_verifier, browser_hash, expires_at)
      SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM oauth_states WHERE expires_at > ?) < 32`)
      .bind(await sha256(state), verifier, browserHash, timestamp + OAUTH_TTL, timestamp),
  ]);
  if (!results[1].meta.changes) return json({ error: "sign-in is busy; try again shortly" }, 429, { "Retry-After": "60" });
  const url = new URL("https://accounts.spotify.com/authorize");
  url.search = new URLSearchParams({ client_id: env.SPOTIFY_CLIENT_ID, response_type: "code", redirect_uri: `${env.APP_ORIGIN}/api/owner/callback`, state, code_challenge_method: "S256", code_challenge: await sha256Base64Url(verifier), scope: "user-read-private" }).toString();
  return json({ authorizeUrl: url.toString() }, 200, { "Set-Cookie": oauthCookie(browser, env) });
}

async function finishLogin(code: string, verifier: string, env: Env): Promise<Response> {
  const tokenResponse = await fetchWithDeadline("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.SPOTIFY_CLIENT_ID, grant_type: "authorization_code", code, redirect_uri: `${env.APP_ORIGIN}/api/owner/callback`, code_verifier: verifier }),
  });
  if (!tokenResponse.ok) { await tokenResponse.body?.cancel(); return error("Spotify authorization failed", 401); }
  const token = await tokenResponse.json<{ access_token?: unknown }>();
  if (!token || typeof token.access_token !== "string" || !token.access_token) return error("Spotify returned a malformed token", 502);
  const me = await fetchWithDeadline("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!me.ok) { await me.body?.cancel(); return error("Spotify profile lookup failed", 401); }
  const profile = await me.json<{ account_id?: unknown }>();
  if (!profile || typeof profile.account_id !== "string" || !profile.account_id) return error("Spotify returned a malformed profile", 502);
  if (profile.account_id !== env.OWNER_SPOTIFY_ID) return error("this Spotify account is not the configured owner", 403);
  const rawSession = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM owner_sessions WHERE expires_at <= ?").bind(now()),
    env.DB.prepare("INSERT INTO owner_sessions (session_hash, spotify_account_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await hmacSha256(rawSession, env.SESSION_SECRET), profile.account_id, now() + SESSION_TTL, now()),
  ]);
  log("owner_login", { owner: true });
  return new Response(null, { status: 302, headers: { Location: `${env.APP_ORIGIN}/?owner=1`, "Set-Cookie": cookie("ferto_session", rawSession, production(env), true, SESSION_TTL / 1000) } });
}

async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!state || (!code && !url.searchParams.has("error"))) return error("invalid OAuth callback", 400);
  const browser = parseCookies(request.headers.get("Cookie")).ferto_oauth;
  if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser) || state.length > 128 || (code?.length ?? 0) > 4096) return error("expired OAuth state", 400);
  // Validate browser binding and consume in one write: replay/concurrent
  // callbacks cannot exchange a code twice. A mismatched browser cannot burn
  // another browser's pending transaction.
  const record = await env.DB.prepare(`DELETE FROM oauth_states
    WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING code_verifier`)
    .bind(await sha256(state), await hmacSha256(browser, env.SESSION_SECRET), now()).first<{ code_verifier: string }>();
  if (!record) return error("expired OAuth state", 400);
  let response: Response;
  try {
    response = url.searchParams.has("error") ? error("Spotify sign-in was cancelled", 400) : await finishLogin(code!, record.code_verifier, env);
  } catch {
    log("owner_login_failed");
    response = error("Spotify sign-in could not finish; try again", 502);
  }
  response.headers.append("Set-Cookie", oauthCookie("", env, 0));
  return response;
}

type ResolvedRecording = {
  recordingKey: string | null;
  liveGeneration: string | null;
  liveRecordingKey: string | null;
  activeGeneration: string | null;
  activeRecordingKey: string | null;
};

async function resolveRecording(env: Env, trackId: string): Promise<ResolvedRecording> {
  // A card can remain open while a rebuild promotes a different representative
  // of the same recording. Search retained history as well as current state and
  // prefer an ISRC identity, while retaining exact live/staging aliases so a
  // migrated spotify:<id> row disappears immediately after an ISRC upgrade.
  const row = await env.DB.prepare(
    `SELECT
       (SELECT live_generation FROM refresh_state WHERE singleton = 1) AS live_generation,
       (SELECT generation FROM rebuild_jobs WHERE singleton = 1 AND status = 'active') AS active_generation,
       (SELECT r.recording_key FROM recordings r
        WHERE r.spotify_id = ?
        ORDER BY CASE WHEN r.recording_key LIKE 'isrc:%' THEN 0 ELSE 1 END,
                 CASE WHEN r.generation = (SELECT live_generation FROM refresh_state WHERE singleton = 1) THEN 0 ELSE 1 END
        LIMIT 1) AS recording_key,
       (SELECT r.recording_key FROM recordings r
        WHERE r.spotify_id = ?
          AND r.generation = (SELECT live_generation FROM refresh_state WHERE singleton = 1)
        LIMIT 1) AS live_recording_key,
       (SELECT r.recording_key FROM recordings r
        WHERE r.spotify_id = ?
          AND r.generation = (SELECT generation FROM rebuild_jobs WHERE singleton = 1 AND status = 'active')
        LIMIT 1) AS active_recording_key`,
  ).bind(trackId, trackId, trackId).first<{ recording_key: string | null; live_generation: string | null; live_recording_key: string | null; active_generation: string | null; active_recording_key: string | null }>();
  return {
    recordingKey: row?.recording_key ?? null,
    liveGeneration: row?.live_generation ?? null,
    liveRecordingKey: row?.live_recording_key ?? null,
    activeGeneration: row?.active_generation ?? null,
    activeRecordingKey: row?.active_recording_key ?? null,
  };
}

async function likeRecording(env: Env, trackId: string): Promise<Response | string | null> {
  const resolved = await resolveRecording(env, trackId);
  let key = resolved.recordingKey;
  let accessToken: string;
  try {
    const token = await spotifyAccessToken(env, env.SPOTIFY_REFRESH_TOKEN);
    accessToken = token.access_token;
  } catch {
    return error("Spotify save could not be confirmed; candidate retained", 502);
  }

  // A stale migrated card can be spotify:oldId while the current generation is
  // isrc:I under a different Spotify id. Confirm that ISRC before saving so a
  // transient lookup failure changes neither Spotify nor the local shelf.
  if (!key || key.startsWith("spotify:")) {
    try {
      const response = await fetchWithDeadline(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (response.ok) {
        const track = await response.json<{ id?: unknown; external_ids?: { isrc?: unknown } }>();
        key = recordingKey(normalizeIsrc(track.external_ids?.isrc), isTrackId(track.id) ? track.id : trackId);
      } else if (response.status === 403 || response.status === 404) {
        key ??= recordingKey(null, trackId);
      } else {
        return error("Spotify track lookup failed; candidate retained. Try again.", 503);
      }
    } catch {
      return error("Spotify track lookup failed; candidate retained. Try again.", 503);
    }
  }

  // Spotify's 2026 Development Mode API removed the content-specific
  // PUT /me/tracks route. The generic library endpoint accepts Spotify URIs
  // as a query parameter and works in both Development and Extended modes.
  const library = new URL("https://api.spotify.com/v1/me/library");
  library.searchParams.set("uris", `spotify:track:${trackId}`);
  try {
    const saved = await fetchWithDeadline(library.toString(), { method: "PUT", headers: { Authorization: `Bearer ${accessToken}` } });
    if (!saved.ok) return error("Spotify save could not be confirmed; candidate retained", 502);
  } catch {
    // A timed-out PUT may have reached Spotify. Keep the card and let the
    // owner retry the idempotent save; never retry a write automatically.
    return error("Spotify save could not be confirmed; candidate retained", 502);
  }

  if (!key) return null;
  // Re-read destinations in one SQL snapshot after Spotify confirms the save.
  // Across promotion this yields either old-live + active-staging, or the new
  // live generation; it can never observe old-live + no active generation.
  const destinations = await resolveRecording(env, trackId);
  if (destinations.recordingKey?.startsWith("isrc:")) key = destinations.recordingKey;
  const live = destinations.liveGeneration;
  const active = destinations.activeGeneration;
  const statements = [];
  if (live) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(live, key));
  if (live && destinations.liveRecordingKey && destinations.liveRecordingKey !== key) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(live, destinations.liveRecordingKey));
  if (active && active !== live) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(active, key));
  if (active && active !== live && destinations.activeRecordingKey && destinations.activeRecordingKey !== key) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(active, destinations.activeRecordingKey));
  if (statements.length) await env.DB.batch(statements);
  if (live) await removeFromRecommendationPool(env, live, destinations.liveRecordingKey ?? key);
  // If promotion linearized after the destination snapshot, this generation is
  // live now; compacting it also repairs counts before the owner request ends.
  if (active && active !== live) await removeFromRecommendationPool(env, active, destinations.activeRecordingKey ?? key);
  return key;
}

async function neverRecording(env: Env, trackId: string): Promise<Response | string> {
  const resolved = await resolveRecording(env, trackId);
  let key = resolved.recordingKey;
  if (key === null || key.startsWith("spotify:")) {
    // No ISRC-confirmed identity: confirm recording-wide identity with an
    // immediate full-track lookup. A transient failure must not silently fall
    // back to a weaker identity, so the whole request fails instead.
    try {
      const token = await spotifyAccessToken(env, env.SPOTIFY_REFRESH_TOKEN);
      const response = await fetchWithDeadline(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (response.ok) {
        const track = await response.json<{ id?: unknown; external_ids?: { isrc?: unknown } }>();
        const confirmedId = isTrackId(track.id) ? track.id : trackId;
        key = recordingKey(normalizeIsrc(track.external_ids?.isrc), confirmedId);
      } else if (response.status === 403 || response.status === 404) {
        // The object itself is unavailable; an exact-id exclusion is the only
        // identity that can ever be confirmed for it.
        key = recordingKey(null, trackId);
      } else {
        return error("Spotify track lookup failed; exclusion not saved. Try again.", 503);
      }
    } catch {
      return error("Spotify track lookup failed; exclusion not saved. Try again.", 503);
    }
  }
  const isrc = key.startsWith("isrc:") ? key.slice("isrc:".length) : null;
  const live = resolved.liveGeneration;
  const active = resolved.activeGeneration;
  const statements = [env.DB.prepare("INSERT OR IGNORE INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, ?, ?, ?)").bind(key, isrc, trackId, now())];
  if (live && resolved.liveRecordingKey && resolved.liveRecordingKey !== key) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(live, resolved.liveRecordingKey));
  if (active && active !== live && resolved.activeRecordingKey && resolved.activeRecordingKey !== key) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(active, resolved.activeRecordingKey));
  await env.DB.batch(statements);
  if (live) {
    await removeFromRecommendationPool(env, live, resolved.liveRecordingKey ?? key);
  }
  if (active && active !== live) await removeFromRecommendationPool(env, active, resolved.activeRecordingKey ?? key);
  return key;
}

async function ownerWrite(request: Request, env: Env, mode: "like" | "never"): Promise<Response> {
  const protectedRequest = await requireMutationProtection(request, env);
  if (protectedRequest) return protectedRequest;
  const unauthorized = await requireOwner(request, env);
  if (unauthorized) return unauthorized;
  const body = await jsonObject(request);
  // Only a Spotify track id is accepted; the server resolves the recording key.
  if (!body.trackId || !isTrackId(body.trackId)) return error("valid trackId required", 400);
  const result = mode === "like" ? await likeRecording(env, body.trackId) : await neverRecording(env, body.trackId);
  if (result instanceof Response) return result;
  log(mode === "like" ? "track_liked" : "track_never_again", { track_id: body.trackId });
  return json({ ok: true, recordingId: typeof result === "string" ? await sha256(result) : null });
}

async function logout(request: Request, env: Env): Promise<Response> { const blocked = await requireMutationProtection(request, env); if (blocked) return blocked; const raw = parseCookies(request.headers.get("Cookie")).ferto_session; if (raw) await env.DB.prepare("DELETE FROM owner_sessions WHERE session_hash = ?").bind(await hmacSha256(raw, env.SESSION_SECRET)).run(); log("owner_logout"); return json({ ok: true }, 200, { "Set-Cookie": cookie("ferto_session", "", production(env), true, 0) }); }

async function refresh(request: Request, env: Env): Promise<Response> {
  const protectedRequest = await requireMutationProtection(request, env);
  if (protectedRequest) return protectedRequest;
  const unauthorized = await requireOwner(request, env);
  if (unauthorized) return unauthorized;
  return json(await startOrWakeRebuild(env), 202);
}

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (!url.pathname.startsWith("/api/")) return await env.ASSETS.fetch(request);
      if (request.method === "GET" && url.pathname === "/api/recommendation" && !await requestBudget(request, env, "draw")) {
        return json({ error: "too many requests; try again shortly" }, 429, { "Retry-After": "60" });
      }
      if (request.method === "GET" && url.pathname === "/api/recommendation") return await recommendation(request, env);
      if (request.method === "GET" && url.pathname === "/api/owner/session") return await ownerSession(request, env);
      if (request.method === "POST" && url.pathname === "/api/owner/login") return await login(request, env);
      if (request.method === "GET" && url.pathname === "/api/owner/callback") return await callback(request, env);
      if (request.method === "POST" && url.pathname === "/api/owner/like") return await ownerWrite(request, env, "like");
      if (request.method === "POST" && url.pathname === "/api/owner/never-again") return await ownerWrite(request, env, "never");
      if (request.method === "POST" && url.pathname === "/api/owner/refresh") return await refresh(request, env);
      if (request.method === "GET" && url.pathname === "/api/owner/history") {
        const unauthorized = await requireOwner(request, env);
        if (unauthorized) return unauthorized;
        return json(await operationalHistory(env));
      }
      if (request.method === "GET" && url.pathname === "/api/owner/refresh") {
        const unauthorized = await requireOwner(request, env);
        if (unauthorized) return unauthorized;
        return json(await statusSnapshot(env), 200, csrfHeader(request, env));
      }
      if (request.method === "POST" && url.pathname === "/api/owner/logout") return await logout(request, env);
      return error("not found", 404);
    } catch (cause) {
      if (cause instanceof RequestError) return error(cause.message, cause.status);
      // Exceptions may contain provider bodies, SQL bindings or credentials.
      // Record the route and a fixed category rather than exception text.
      console.error(JSON.stringify({ event: "request_failed", path: url.pathname, reason: "unexpected_error" }));
      return error("request failed", 500);
    }
  },
  async queue(batch: MessageBatch<RefreshMessage>, env: Env): Promise<void> {
    await consumeRefreshQueue(batch, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledTick(env, controller.scheduledTime, controller.cron));
  },
} satisfies ExportedHandler<Env, RefreshMessage>;

export default {
  fetch: async (request: Request, env: Env) => secureResponse(await observedInvocation(env, new URL(request.url).pathname.startsWith("/api/owner/") ? "owner" : "public", "", (observed) => handler.fetch(request, observed)), request, env.APP_ORIGIN),
  queue: (batch: MessageBatch<RefreshMessage>, env: Env) => observedInvocation(env, "refresh", batch.messages[0]?.body?.generation ?? "", (observed) => handler.queue(batch, observed)),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(observedInvocation(env, "scheduler", "", async (observed) => {
      await cleanupRequestState(observed);
      await scheduledTick(observed, controller.scheduledTime, controller.cron);
    }));
  },
} satisfies ExportedHandler<Env, RefreshMessage>;
