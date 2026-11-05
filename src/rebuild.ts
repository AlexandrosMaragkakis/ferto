import { compareRepresentatives, isTrackId, normalizeIsrc, Recording, toRecording } from "./domain";
import { randomToken } from "./security";
import { refreshSpotifyAccessToken } from "./spotify";
import { fetchWithDeadline } from "./request";
import { readTrackCache, writeTrackCache } from "./track-cache";
import { invalidateServiceToken, readServiceToken, writeServiceToken, type ServiceToken } from "./service-token-cache";
import { JOB_MUTATION_GUARD, jobMutationBindings, type JobMutationGuard } from "./rebuild-guard";
import { progressStatement, countedRequest, requestEndpoint, saveRequestUsage, numericProgress, requestUsage, type RequestUsage, type RequestEndpoint } from "./rebuild-progress";
import { catalogueContext, knownTracks, knownTrackStatements, knownIdentityStatements, unknownTrackIds, readPlaylistPage,
  playlistPageStatement, readAlbumPage, albumPageStatement, albumAvailabilityStatements, PLAYLIST_CACHE_TTL_MS } from "./catalogue-cache";

export type RefreshMessage = { generation: string; revision: number };
export type RefreshPhase =
  | "preflight"
  | "never_identities"
  | "seeds"
  | "artist_albums"
  | "album_tracks"
  | "enrich"
  | "known_liked"
  | "known_playlists"
  | "known_playlist_items"
  | "promote";
export type PromotionOutcome = "promoted" | "quarantined" | "empty";
export type LatestOutcome = PromotionOutcome | "failed";

type SpotifyPage<T> = { items: T[]; next: string | null };
type SpotifyArtist = { id?: unknown; name?: unknown };
type SpotifyImage = { url?: unknown };
type SpotifyAlbum = { id?: unknown; name?: unknown; images?: SpotifyImage[] | null };
type SpotifyTrackStub = { id?: unknown; linked_from?: { id?: unknown } | null; artists?: SpotifyArtist[] | null };
type SpotifySavedTrack = { track?: SpotifyTrackStub | null };
type SpotifyPlaylist = { id?: unknown; snapshot_id?: unknown; collaborative?: unknown; owner?: { id?: unknown } | null };
type SpotifyPlaylistItem = {
  /** Current /items response shape. */
  item?: SpotifyTrackStub | null;
  /** Kept as a compatibility fallback for older Extended Mode responses. */
  track?: SpotifyTrackStub | null;
};

type RebuildJobRow = {
  singleton: number;
  generation: string;
  status: "active" | "failed";
  phase: RefreshPhase;
  market: string | null;
  owner_user_id: string | null;
  cursor: string | null;
  work_key: string | null;
  fair_scheduler: number;
  priority_new_artists: number;
  revision: number;
  lease_until: number | null;
  retry_at: number | null;
  wait_reason: "rate_limit" | "quota" | "upstream" | null;
  retry_count: number;
  next_read_at: number;
  dispatch_pending: number;
  started_at: number;
  updated_at: number;
  pace_multiplier: number;
  pace_successes: number;
  progress_json: string;
  request_counts_json: string;
  progress_started_at: number | null;
  progress_partial: number;
  retry_source: "spotify" | "backoff" | null;
  quota_attempts: number;
  quota_wait_started_at: number | null;
  quota_endpoint: RequestEndpoint | null;
  quota_last_recovery_at: number | null;
  quota_last_wait_ms: number | null;
  usage?: RequestUsage;
  deadlineAt?: number;
};

type CountRow = { count: number };
type StateRow = {
  live_generation: string | null;
  refreshed_at: number | null;
  candidate_count: number;
  last_error: string | null;
  pending_low: number;
  last_outcome: LatestOutcome | null;
  last_outcome_at: number | null;
  next_refresh_at: number | null;
  warnings_json: string | null;
  last_progress_json: string;
  last_request_counts_json: string;
  last_progress_started_at: number | null;
  last_progress_partial: number;
  last_publication_at: number | null;
};

export type RefreshStatus = {
  state: "idle" | "active" | "waiting" | "failed";
  refreshId: string | null;
  phase: RefreshPhase | null;
  phaseLabel: string | null;
  progress: Record<string, number>;
  requests: RequestUsage;
  requestCountBasis: "observed";
  progressPartial: boolean;
  progressSinceAt: number | null;
  retrySource?: "spotify" | "backoff";
  quotaRecoveryAt?: number;
  quotaObservedWaitMs?: number;
  latestOutcome: LatestOutcome | null;
  latestOutcomeAt: number | null;
  candidateCount: number;
  refreshedAt: number | null;
  lastPublicationAt: number | null;
  warnings: string[];
  nextRefreshAt: number | null;
  error?: string;
  retryAfterSeconds?: number;
  retryAt?: number;
  waitReason?: "rate_limit" | "quota" | "upstream";
};

type AdvanceOutcome =
  | { kind: "scheduled"; delaySeconds: number }
  | { kind: "complete"; outcome: PromotionOutcome }
  | { kind: "busy"; delaySeconds: number }
  | { kind: "failed" };

type WarningCounts = {
  artistsUnavailable?: number;
  albumsUnavailable?: number;
  trackBatchesUnavailable?: number;
  playlistsUnavailable?: number;
};

export const CRON_EXPRESSION = "0 3 * * SUN";
export const WATCHDOG_CRON_EXPRESSION = "*/15 * * * *";
const SERVICE_SCOPES = ["user-library-read", "user-library-modify", "playlist-read-private", "playlist-read-collaborative", "user-read-private"] as const;
const LIKED_URL = "https://api.spotify.com/v1/me/tracks?limit=50";
const PLAYLISTS_URL = "https://api.spotify.com/v1/me/playlists?limit=50";
// Pages start at 2s spacing; a 30-track batch still waits at least 30s.
// Rolling 429s increase the durable multiplier; clean units gradually reduce it.
const MIN_READ_GAP_SECONDS = 2;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_DELAY_SECONDS = 900;
const REFRESH_LEASE_MS = 120_000;
// Free-plan invocations permit 50 external subrequests and 50 D1 queries.
// Enrichment spends one external request and potentially one staged write per
// track, so 30 leaves headroom for token refresh, leases, cursors, publishing,
// and Queue dispatch. Workers allow at most six open connections.
const ENRICH_BATCH_LIMIT = 30;
const ENRICH_CONCURRENCY = 5;
// Work on a bounded group until artists finish, then admit new ones. A sweep
// across thousands of release lists must not postpone every song lookup.
const ARTIST_WORKING_SET = 8;
const NEVER_IDENTITY_BATCH_LIMIT = 50; // two bindings each: D1 permits 100
// The live queue retains messages for 24h. Re-send waits in 12h chunks so
// a daily quota delay never expires at the retention boundary before delivery.
const MAX_QUEUE_DELAY_SECONDS = 43_200;
// With no provider timing, retry one metadata request at increasing intervals.
// These are probe times, not claims about Spotify's unpublished quota reset.
const QUOTA_RETRY_SECONDS = 900;
const QUOTA_RETRY_MAX_SECONDS = 21_600;
const UPSTREAM_RETRY_SECONDS = 3_600;
// A completed generation must keep at least half of the current live shelf
// before it may replace it; the first miss is quarantined, the second promotes.
const PROMOTION_SIMILARITY_FLOOR = 0.5;
const DAY_MS = 24 * 60 * 60 * 1000;
const PHASE_LABELS: Record<RefreshPhase, string> = {
  preflight: "Preflight",
  never_identities: "Never identity check",
  seeds: "Liked track scan",
  artist_albums: "Artist releases",
  album_tracks: "Release tracks",
  enrich: "Track enrichment",
  known_liked: "Known-track scan",
  known_playlists: "Playlist discovery",
  known_playlist_items: "Playlist items",
  promote: "Promotion",
};
const WARNING_LABELS: [keyof WarningCounts, string][] = [
  ["artistsUnavailable", "artists unavailable"],
  ["albumsUnavailable", "releases unavailable"],
  ["trackBatchesUnavailable", "tracks unavailable"],
  ["playlistsUnavailable", "playlists unavailable"],
];
const ELIGIBLE_FILTER = `NOT EXISTS (
    SELECT 1 FROM never_recordings n
    WHERE n.recording_key = r.recording_key
       OR n.spotify_id = r.spotify_id
       OR (n.isrc IS NOT NULL AND n.isrc = r.isrc)
  )
  AND NOT EXISTS (SELECT 1 FROM rebuild_known_recordings k WHERE k.generation = r.generation AND k.recording_key = r.recording_key)`;

class RefreshFailure extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly reason: string,
    readonly retryAfterSeconds?: number,
    readonly quotaExceeded = false,
    readonly endpoint?: RequestEndpoint,
  ) {
    super(`${operation} failed (${status}): ${reason}`);
  }
}

const now = () => Date.now();

function safeReason(value: unknown, env?: Env, accessToken?: string): string {
  let text = typeof value === "string" ? value : "Spotify request failed";
  for (const secret of env ? [env.SPOTIFY_CLIENT_ID, env.SPOTIFY_REFRESH_TOKEN, env.SESSION_SECRET, accessToken] : []) if (secret) text = text.split(secret).join("[redacted]");
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/https?:\/\/[^\s]+/gi, "[redacted]").replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted]").replace(/(?:access|refresh)[_-]?token\s*[=:]\s*[^\s,;]+/gi, "token=[redacted]").replace(/\s+/g, " ").trim().slice(0, 180) || "Spotify request failed";
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("Retry-After")?.trim();
  if (!header) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - now()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const maxSafeSeconds = Math.floor((Number.MAX_SAFE_INTEGER - now()) / 1000);
  return Math.min(maxSafeSeconds, Math.max(1, Math.ceil(seconds)));
}

function expectedSkip(cause: unknown): cause is RefreshFailure {
  return cause instanceof RefreshFailure && (cause.status === 403 || cause.status === 404);
}

// A unit stops issuing network reads after 90s, leaving 30s of its lease
// for database work, failure persistence and Queue acknowledgement.
function requestTimeout(job: RebuildJobRow): number {
  const remaining = (job.deadlineAt ?? (now() + 90_000)) - now();
  if (remaining <= 0) throw new RefreshFailure("refresh", 0, "unit network deadline reached");
  return Math.min(10_000, remaining);
}

type SpotifySession = ServiceToken & { job: RebuildJobRow; reads: number; refreshed?: boolean; renewal?: Promise<SpotifySession> };

async function accessToken(env: Env, job: RebuildJobRow, forceRefresh = false): Promise<SpotifySession> {
  if (!forceRefresh) {
    const cached = await readServiceToken(env);
    if (cached) return { ...cached, job, reads: 0 };
  }
  const timeoutMs = requestTimeout(job);
  const response = await countedRequest(job.usage ??= {}, "token", () => refreshSpotifyAccessToken(env, env.SPOTIFY_REFRESH_TOKEN, timeoutMs));
  if (!response.ok) throw new RefreshFailure("access token", response.status, "Spotify token refresh failed", (response.status === 429 || response.status >= 500) ? retryAfter(response) : undefined);
  const body = await response.json<{ access_token?: unknown; expires_in?: unknown; scope?: unknown }>();
  if (typeof body.access_token !== "string" || !body.access_token) throw new RefreshFailure("access token", 502, "Spotify returned malformed token response");
  const token = { access_token: body.access_token, scope: typeof body.scope === "string" ? body.scope : "" };
  await writeServiceToken(env, token, body.expires_in);
  console.log(JSON.stringify({ event: "rebuild_token_refreshed" }));
  return { ...token, job, reads: 0 };
}

async function spotifyData(url: string, token: SpotifySession, operation: string, env: Env): Promise<Response> {
  let response: Response;
  let usedToken = token.access_token;
  try {
    let timeoutMs = requestTimeout(token.job);
    token.reads += 1;
    response = await countedRequest(token.job.usage ??= {}, requestEndpoint(url), () => fetchWithDeadline(url, { headers: { Authorization: `Bearer ${usedToken}` } }, timeoutMs));
    // Share one renewal within this invocation, including concurrent siblings.
    // A second 401 with the replacement is terminal, not an infinite refresh loop.
    if (response.status === 401 && (!token.refreshed || usedToken !== token.access_token)) {
      await response.body?.cancel();
      token.renewal ??= (async () => { await invalidateServiceToken(env); return accessToken(env, token.job, true); })();
      const replacement = await token.renewal;
      token.access_token = replacement.access_token;
      token.scope = replacement.scope;
      token.refreshed = true;
      usedToken = token.access_token;
      timeoutMs = requestTimeout(token.job);
      token.reads += 1;
      response = await countedRequest(token.job.usage ??= {}, requestEndpoint(url), () => fetchWithDeadline(url, { headers: { Authorization: `Bearer ${usedToken}` } }, timeoutMs));
    }
  } catch (cause) {
    if (cause instanceof RefreshFailure) throw cause;
    throw new RefreshFailure(operation, 0, "Spotify request failed (network)");
  }
  if (!response.ok) {
    let reason = "Spotify request failed";
    let quotaExceeded = false;
    try {
      const body = await response.json() as { error?: { message?: unknown; reason?: unknown } | unknown; message?: unknown; reason?: unknown };
      const spotifyError = body.error && typeof body.error === "object" ? body.error as { message?: unknown; reason?: unknown } : null;
      reason = safeReason(spotifyError?.message ?? body.message ?? body.error, env, usedToken);
      quotaExceeded = (spotifyError?.reason ?? body.reason) === "QUOTA_EXCEEDED";
    } catch {
      // Keep the generic, non-sensitive reason.
    }
    throw new RefreshFailure(operation, response.status, reason, (response.status === 429 || response.status >= 500) ? retryAfter(response) : undefined, quotaExceeded, requestEndpoint(url));
  }
  return response;
}

async function spotifyPage<T>(url: string, token: SpotifySession, operation: string, env: Env): Promise<SpotifyPage<T>> {
  const response = await spotifyData(url, token, operation, env);
  const data = await response.json() as { items?: unknown; next?: unknown };
  if (!data || !Array.isArray(data.items)) throw new RefreshFailure(operation, 502, "Spotify page items missing");
  if (data.next !== null && data.next !== undefined && (typeof data.next !== "string" || !data.next.startsWith("https://api.spotify.com/"))) {
    throw new RefreshFailure(operation, 502, "Spotify returned malformed next cursor");
  }
  return { items: data.items as T[], next: typeof data.next === "string" ? data.next : null };
}

const artistAlbumsUrl = (artistId: string) => `https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}/albums?include_groups=album,single&limit=10`;
function spotifyUrl(path: string, parameters: Record<string, string>, market: string | null): string {
  const url = new URL(`https://api.spotify.com/v1/${path}`);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  // Development Mode no longer guarantees `country` on GET /me. Omitting the
  // market is valid for a user token: Spotify applies the account's country.
  if (market) url.searchParams.set("market", market);
  return url.toString();
}

const albumTracksUrl = (albumId: string, market: string | null) => spotifyUrl(`albums/${encodeURIComponent(albumId)}/tracks`, { limit: "50" }, market);
const trackUrl = (trackId: string, market: string | null) => spotifyUrl(`tracks/${encodeURIComponent(trackId)}`, {}, market);
const playlistItemsUrl = (playlistId: string, market: string | null) => spotifyUrl(`playlists/${encodeURIComponent(playlistId)}/items`, { limit: "50" }, market);

function enrichmentLimit(job: RebuildJobRow): number {
  return Math.max(1, Math.floor((job.quota_attempts > 0 ? 1 : ENRICH_BATCH_LIMIT) / job.pace_multiplier));
}

type FetchedTrack = { cached?: boolean; id: string; track: unknown | null; skippedStatus?: number };

/** Stop after a failed group, retaining all successful requests for checkpointing. */
async function fetchTracks(env: Env, job: RebuildJobRow, ids: string[], operation: string): Promise<{
  fetched: FetchedTrack[]; performedDataRead: number; failure: unknown | null;
}> {
  const cached = await readTrackCache(env, job.market, ids);
  const fetched: FetchedTrack[] = ids.filter((id) => cached.has(id)).map((id) => ({ id, track: cached.get(id), cached: true }));
  const missing = ids.filter((id) => !cached.has(id));
  if (!missing.length) {
    if (ids.length) console.log(JSON.stringify({ event: "rebuild_track_reads", cached: cached.size, spotify_reads: 0 }));
    return { fetched, performedDataRead: 0, failure: null };
  }
  const token = await accessToken(env, job);
  const fresh: FetchedTrack[] = [];
  let failure: unknown | null = null;
  const progress = numericProgress(job.progress_json);
  const competingArtists = (progress.seedArtists ?? 2) - (progress.seedArtistsDone ?? 0) > 1;
  // The turn budget limits HTTP misses, not cheap cache hits. Once only one
  // artist remains, use the full bounded batch again to reduce D1 work.
  const requestIds = job.fair_scheduler && competingArtists ? missing.slice(0, 5) : missing;
  const concurrency = Math.max(1, Math.floor((job.quota_attempts > 0 ? 1 : ENRICH_CONCURRENCY) / job.pace_multiplier));
  for (let start = 0; start < requestIds.length; start += concurrency) {
    const settled = await Promise.allSettled(requestIds.slice(start, start + concurrency).map(async (id): Promise<FetchedTrack> => {
      try {
        const response = await spotifyData(trackUrl(id, job.market), token, operation, env);
        const track = await response.json() as unknown;
        if (!track || typeof track !== "object" || !isTrackId((track as { id?: unknown }).id)) {
          throw new RefreshFailure(operation, 502, "Spotify returned a malformed track");
        }
        return { id, track };
      } catch (cause) {
        if (!expectedSkip(cause)) throw cause;
        return { id, track: null, skippedStatus: cause.status };
      }
    }));
    for (const result of settled) {
      if (result.status === "fulfilled") fresh.push(result.value);
      else if (failure === null) failure = result.reason;
      else if (result.reason instanceof RefreshFailure && result.reason.status === 429) {
        if (!(failure instanceof RefreshFailure) || failure.status !== 429) failure = result.reason;
        else {
          // Preserve quota classification and the longest server wait across
          // concurrent failures, including mixed rolling/quota 429 responses.
          const preferred = result.reason.quotaExceeded ? result.reason : failure;
          const seconds = Math.max(failure.retryAfterSeconds ?? 0, result.reason.retryAfterSeconds ?? 0) || undefined;
          failure = new RefreshFailure(preferred.operation, 429, preferred.reason, seconds, preferred.quotaExceeded, preferred.endpoint);
        }
      }
    }
    if (failure !== null) break;
  }
  await writeTrackCache(env, job.market, fresh);
  fetched.push(...fresh);
  console.log(JSON.stringify({ event: "rebuild_track_reads", cached: cached.size, spotify_reads: token.reads }));
  return { fetched, performedDataRead: token.reads, failure };
}

async function currentJob(env: Env): Promise<RebuildJobRow | null> {
  return env.DB.prepare(
    "SELECT singleton, generation, status, phase, market, owner_user_id, cursor, work_key, fair_scheduler, priority_new_artists, revision, lease_until, retry_at, wait_reason, retry_count, next_read_at, dispatch_pending, started_at, updated_at, pace_multiplier, pace_successes, progress_json, request_counts_json, progress_started_at, progress_partial, retry_source, quota_attempts, quota_wait_started_at, quota_endpoint, quota_last_recovery_at, quota_last_wait_ms FROM rebuild_jobs WHERE singleton = 1",
  ).first<RebuildJobRow>();
}

async function eligibleCount(env: Env, generation: string, excludePublicationsFrom?: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS count FROM recordings r WHERE r.generation = ? AND ${ELIGIBLE_FILTER}
    AND NOT EXISTS (SELECT 1 FROM refresh_publications p WHERE p.generation=? AND p.live_generation=r.generation AND p.recording_key=r.recording_key)`)
    .bind(generation, excludePublicationsFrom ?? null).first<CountRow>())?.count ?? 0;
}

async function overlapCount(env: Env, oldGeneration: string, newGeneration: string): Promise<number> {
  return (await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM recordings n JOIN recordings o ON o.recording_key = n.recording_key
     WHERE n.generation = ? AND o.generation = ?
       AND NOT EXISTS (SELECT 1 FROM never_recordings nv WHERE nv.recording_key = n.recording_key OR nv.spotify_id = n.spotify_id OR (nv.isrc IS NOT NULL AND nv.isrc = n.isrc))
       AND NOT EXISTS (SELECT 1 FROM rebuild_known_recordings k WHERE k.generation = n.generation AND k.recording_key = n.recording_key)
       AND NOT EXISTS (SELECT 1 FROM never_recordings nv2 WHERE nv2.recording_key = o.recording_key OR nv2.spotify_id = o.spotify_id OR (nv2.isrc IS NOT NULL AND nv2.isrc = o.isrc))
       AND NOT EXISTS (SELECT 1 FROM rebuild_known_recordings k2 WHERE k2.generation = o.generation AND k2.recording_key = o.recording_key)
       AND NOT EXISTS (SELECT 1 FROM refresh_publications p WHERE p.generation=? AND p.live_generation=o.generation AND p.recording_key=o.recording_key)`,
  ).bind(newGeneration, oldGeneration, newGeneration).first<CountRow>())?.count ?? 0;
}

async function acquireLease(env: Env, job: RebuildJobRow): Promise<boolean> {
  const timestamp = now();
  const result = await env.DB.prepare(
    "UPDATE rebuild_jobs SET lease_until = ? WHERE singleton = 1 AND generation = ? AND revision = ? AND status = 'active' AND (lease_until IS NULL OR lease_until <= ?)",
  ).bind(timestamp + REFRESH_LEASE_MS, job.generation, job.revision, timestamp).run();
  return result.meta.changes === 1;
}

type JobChanges = Partial<Pick<RebuildJobRow, "phase" | "cursor" | "market" | "owner_user_id" | "work_key">>;
function jobStatement(env: Env, job: RebuildJobRow, changes: JobChanges): D1PreparedStatement {
  const next = { ...job, ...changes };
  return env.DB.prepare(
    "UPDATE rebuild_jobs SET phase = ?, cursor = ?, market = ?, owner_user_id = ?, work_key = ?, updated_at = ? WHERE singleton = 1 AND generation = ? AND revision = ? AND phase = ? AND status = 'active'",
  ).bind(next.phase, next.cursor, next.market, next.owner_user_id, next.work_key, now(), job.generation, job.revision, job.phase);
}
async function setJob(env: Env, job: RebuildJobRow, changes: JobChanges): Promise<void> {
  await jobStatement(env, job, changes).run();
  Object.assign(job, changes);
}

async function completeArtist(env: Env, job: RebuildJobRow): Promise<void> {
  const changes: JobChanges = { phase: "artist_albums", cursor: null, work_key: null };
  const live = await env.DB.prepare(`SELECT s.live_generation,EXISTS(SELECT 1 FROM recordings r
    WHERE r.generation=? AND r.bucket_artist_id=? AND ${ELIGIBLE_FILTER}
      AND EXISTS(SELECT 1 FROM rebuild_seed_artists a WHERE a.generation=r.generation AND a.spotify_id=? AND a.status='catalogued')
      AND NOT EXISTS(SELECT 1 FROM recordings old WHERE old.generation=s.live_generation AND old.recording_key=r.recording_key)) AS additions
    FROM refresh_state s WHERE singleton=1`).bind(job.generation,job.work_key,job.work_key)
    .first<{ live_generation: string | null; additions: number }>();
  await env.DB.batch([
    ...(live?.live_generation && live.additions && live.live_generation !== job.generation && job.work_key
      ? artistPublicationStatements(env, job, live.live_generation, job.work_key) : []),
    progressStatement(env, job, { seedArtistsDone: 1 }, "EXISTS (SELECT 1 FROM rebuild_seed_artists WHERE generation = ? AND spotify_id = ? AND status = 'catalogued')", [job.generation, job.work_key]),
    env.DB.prepare(`DELETE FROM rebuild_seed_artists WHERE generation = ? AND spotify_id = ? AND status = 'catalogued' AND ${JOB_MUTATION_GUARD}`).bind(job.generation, job.work_key, ...jobMutationBindings(job)),
    jobStatement(env, job, changes),
  ]);
  Object.assign(job, changes);
}

// Initial liked/playlist scans have finished before these phases. Publication
// may use only already validated recordings and never bypass those scans.
const PUBLICATION_PHASES: readonly RefreshPhase[] = ["artist_albums", "album_tracks", "enrich", "known_liked", "promote"];

/** Publish a bounded validated batch, or finish an upgraded artist's backlog.
 * Existing cards stay immutable; ledger, copy, slots and counts are atomic. */
function artistPublicationStatements(env: Env, job: RebuildJobRow, liveGeneration: string, artist: string, keys?: string[]): D1PreparedStatement[] {
  const ready = `${keys ? `? IN (${PUBLICATION_PHASES.map(() => '?').join(',')})`
    : "EXISTS (SELECT 1 FROM rebuild_seed_artists a WHERE a.generation=? AND a.spotify_id=? AND a.status='catalogued')"}
    AND (SELECT live_generation FROM refresh_state WHERE singleton=1)=? AND ${JOB_MUTATION_GUARD}`;
  const readyBindings = () => [...(keys ? [job.phase, ...PUBLICATION_PHASES] : [job.generation, artist]), liveGeneration, ...jobMutationBindings(job)];
  const keyFilter = keys ? "AND r.recording_key IN (SELECT value FROM json_each(?))" : "";
  const keyBindings = keys ? [JSON.stringify(keys)] : [];
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO refresh_publications(generation,live_generation,recording_key,bucket_artist_id,published_at)
      SELECT ?,?,r.recording_key,r.bucket_artist_id,? FROM recordings r
      WHERE r.generation=? AND r.bucket_artist_id=? ${keyFilter} AND ${ELIGIBLE_FILTER} AND ${ready}
        AND NOT EXISTS (SELECT 1 FROM recordings old WHERE old.generation=? AND old.recording_key=r.recording_key)
        AND NOT EXISTS (SELECT 1 FROM recordings old WHERE old.generation=? AND old.spotify_id=r.spotify_id)
        AND NOT EXISTS (SELECT 1 FROM rebuild_known_recordings k WHERE k.generation=? AND k.recording_key=r.recording_key)`)
      .bind(job.generation, liveGeneration, now(), job.generation, artist, ...keyBindings, ...readyBindings(), liveGeneration, liveGeneration, liveGeneration),
    env.DB.prepare(`INSERT OR IGNORE INTO recordings(generation,recording_key,spotify_id,isrc,title,album_name,release_date,image_url,spotify_url,artists_json,bucket_artist_id)
      SELECT ?,r.recording_key,r.spotify_id,r.isrc,r.title,r.album_name,r.release_date,r.image_url,r.spotify_url,r.artists_json,r.bucket_artist_id
      FROM recordings r JOIN refresh_publications p ON p.generation=r.generation AND p.recording_key=r.recording_key
      WHERE r.generation=? AND r.bucket_artist_id=? ${keyFilter} AND p.live_generation=? AND ${ready}`)
      .bind(liveGeneration, job.generation, artist, ...keyBindings, liveGeneration, ...readyBindings()),
    ...appendRecommendationPoolStatements(env, liveGeneration, artist, job, true, keys),
  ];
}

export type RecommendationPoolCounts = { candidateCount: number; bucketCount: number };


function recommendationPoolStatements(env: Env, generation: string, job?: JobMutationGuard): D1PreparedStatement[] {
  const guard = job ? JOB_MUTATION_GUARD : "1";
  const bindings = () => jobMutationBindings(job);
  return [
    env.DB.prepare(`DELETE FROM recommendation_slots WHERE generation = ? AND ${guard}`).bind(generation, ...bindings()),
    env.DB.prepare(`DELETE FROM recommendation_buckets WHERE generation = ? AND ${guard}`).bind(generation, ...bindings()),
    env.DB.prepare(
      `INSERT INTO recommendation_slots (generation, bucket_artist_id, track_slot, recording_key)
       SELECT r.generation, r.bucket_artist_id,
              ROW_NUMBER() OVER (PARTITION BY r.bucket_artist_id ORDER BY r.recording_key),
              r.recording_key
       FROM recordings r
       WHERE r.generation = ? AND ${guard} AND ${ELIGIBLE_FILTER}`,
    ).bind(generation, ...bindings()),
    env.DB.prepare(
      `INSERT INTO recommendation_buckets (generation, bucket_slot, bucket_artist_id, track_count)
       SELECT generation, ROW_NUMBER() OVER (ORDER BY bucket_artist_id), bucket_artist_id, track_count
       FROM (
         SELECT generation, bucket_artist_id, COUNT(*) AS track_count
         FROM recommendation_slots WHERE generation = ?
         GROUP BY generation, bucket_artist_id
       ) materialized
       WHERE ${guard}`,
    ).bind(generation, ...bindings()),
  ];
}

/**
 * Rebuild dense per-artist and per-track slots for one generation. Public
 * recommendation requests can then draw two exact integer slots instead of
 * scanning the live catalogue with COUNT/DISTINCT/ORDER BY RANDOM().
 */
export async function rebuildRecommendationPool(env: Env, generation: string): Promise<RecommendationPoolCounts> {
  await env.DB.batch(recommendationPoolStatements(env, generation));
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM recommendation_slots WHERE generation = ?) AS candidateCount,
       (SELECT COUNT(*) FROM recommendation_buckets WHERE generation = ?) AS bucketCount`,
  ).bind(generation, generation).first<RecommendationPoolCounts>();
  return { candidateCount: counts?.candidateCount ?? 0, bucketCount: counts?.bucketCount ?? 0 };
}

function appendRecommendationPoolStatements(env: Env, generation: string, bucketArtistId: string, job?: JobMutationGuard, published = false, keys?: string[]): D1PreparedStatement[] {
  const operationId = randomToken(16);
  const guard = job ? `AND ${JOB_MUTATION_GUARD}` : "";
  // Keep the slot insert and all derived counters in one D1 transaction. This
  // serializes a bootstrap append with owner/public removals and also lets a
  // retried queue delivery make no counter change when it inserts no new row.
  // Capturing changes() avoids an O(N²) COUNT of the growing live catalogue.
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO recommendation_slots (generation, bucket_artist_id, track_slot, recording_key)
       SELECT r.generation, r.bucket_artist_id,
              COALESCE((SELECT MAX(s.track_slot) FROM recommendation_slots s WHERE s.generation = ? AND s.bucket_artist_id = ?), 0)
                + ROW_NUMBER() OVER (ORDER BY r.recording_key),
              r.recording_key
       FROM recordings r
       WHERE r.generation = ? AND r.bucket_artist_id = ? AND ${ELIGIBLE_FILTER}
         ${keys ? "AND r.recording_key IN (SELECT value FROM json_each(?))" : ""}
         ${guard}
         ${published ? `AND EXISTS (SELECT 1 FROM refresh_publications p WHERE p.generation = ?
           AND p.live_generation = r.generation AND p.recording_key = r.recording_key
           AND p.live_generation = (SELECT live_generation FROM refresh_state WHERE singleton=1))` : ""}
         AND NOT EXISTS (
           SELECT 1 FROM recommendation_slots s
           WHERE s.generation = r.generation AND s.recording_key = r.recording_key
         )`,
    ).bind(generation, bucketArtistId, generation, bucketArtistId, ...(keys ? [JSON.stringify(keys)] : []), ...jobMutationBindings(job), ...(published && job ? [job.generation] : [])),
    env.DB.prepare(
      "INSERT INTO recommendation_pool_appends (operation_id, inserted_count) VALUES (?, changes())",
    ).bind(operationId),
    env.DB.prepare(
      `UPDATE recommendation_buckets
       SET track_count = track_count + (
         SELECT inserted_count FROM recommendation_pool_appends WHERE operation_id = ?
       )
       WHERE generation = ? AND bucket_artist_id = ?`,
    ).bind(operationId, generation, bucketArtistId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO recommendation_buckets (generation, bucket_slot, bucket_artist_id, track_count)
       SELECT ?,
              COALESCE((SELECT MAX(bucket_slot) FROM recommendation_buckets WHERE generation = ?), 0) + 1,
              ?, inserted_count
       FROM recommendation_pool_appends
       WHERE operation_id = ? AND inserted_count > 0`,
    ).bind(generation, generation, bucketArtistId, operationId),
    env.DB.prepare(
      "UPDATE recommendation_pool_appends SET bucket_inserted = changes() WHERE operation_id = ?",
    ).bind(operationId),
    env.DB.prepare(
      `UPDATE refresh_state
       SET candidate_count = candidate_count + (
             SELECT inserted_count FROM recommendation_pool_appends WHERE operation_id = ?
           ),
           live_bucket_count = live_bucket_count + (
             SELECT bucket_inserted FROM recommendation_pool_appends WHERE operation_id = ?
           )
       WHERE singleton = 1 AND live_generation = ?`,
    ).bind(operationId, operationId, generation),
  ];
  if (published && job) statements.push(
    progressStatement(env, job, {
      publishedRecordings: { sql: "SELECT inserted_count FROM recommendation_pool_appends WHERE operation_id=?", bindings: [operationId] },
      publishedArtists: { sql: "SELECT bucket_inserted FROM recommendation_pool_appends WHERE operation_id=?", bindings: [operationId] },
    }),
    env.DB.prepare(`UPDATE refresh_state SET last_publication_at=? WHERE singleton=1 AND live_generation=?
      AND (SELECT inserted_count FROM recommendation_pool_appends WHERE operation_id=?)>0 AND ${JOB_MUTATION_GUARD}`)
      .bind(now(), generation, operationId, ...jobMutationBindings(job)),
  );
  statements.push(env.DB.prepare("DELETE FROM recommendation_pool_appends WHERE operation_id = ?").bind(operationId));
  return statements;
}

/** Append live rows and their dense slots atomically, without a shelf recount. */
export async function appendRecommendationPool(env: Env, generation: string, bucketArtistId: string, job?: JobMutationGuard): Promise<void> {
  await env.DB.batch(appendRecommendationPoolStatements(env, generation, bucketArtistId, job));
}

/** Remove one live recording and compact both dense slot ranges atomically. */
export async function removeFromRecommendationPool(env: Env, generation: string, recordingKey: string): Promise<boolean> {
  const operationId = randomToken(16);
  const marker = `(SELECT * FROM recommendation_pool_removals WHERE operation_id = ?)`;
  const results = await env.DB.batch([
    // Snapshot every value needed for compaction inside this transaction.
    // D1 serializes the whole batch, so concurrent calls cannot act on the
    // same pre-mutation slot map or decrement the counters twice.
    env.DB.prepare(
      `INSERT INTO recommendation_pool_removals
         (operation_id, generation, recording_key, bucket_artist_id, track_slot,
          bucket_slot, track_count, last_track_recording_key, last_bucket_artist_id)
       SELECT ?, s.generation, s.recording_key, s.bucket_artist_id, s.track_slot,
              b.bucket_slot, b.track_count,
              (SELECT tail.recording_key FROM recommendation_slots tail
               WHERE tail.generation = s.generation AND tail.bucket_artist_id = s.bucket_artist_id
               ORDER BY tail.track_slot DESC LIMIT 1),
              (SELECT tail.bucket_artist_id FROM recommendation_buckets tail
               WHERE tail.generation = s.generation ORDER BY tail.bucket_slot DESC LIMIT 1)
       FROM recommendation_slots s
       JOIN recommendation_buckets b
         ON b.generation = s.generation AND b.bucket_artist_id = s.bucket_artist_id
       WHERE s.generation = ? AND s.recording_key = ?`,
    ).bind(operationId, generation, recordingKey),
    env.DB.prepare(
      `DELETE FROM recommendation_slots
       WHERE generation = (SELECT generation FROM ${marker})
         AND recording_key = (SELECT recording_key FROM ${marker})`,
    ).bind(operationId, operationId),
    env.DB.prepare(
      `UPDATE recommendation_slots
       SET track_slot = (SELECT track_slot FROM ${marker})
       WHERE generation = (SELECT generation FROM ${marker})
         AND recording_key = (SELECT last_track_recording_key FROM ${marker})`,
    ).bind(operationId, operationId, operationId),
    env.DB.prepare(
      `UPDATE recommendation_buckets
       SET track_count = track_count - 1
       WHERE generation = (SELECT generation FROM ${marker})
         AND bucket_artist_id = (SELECT bucket_artist_id FROM ${marker})
         AND (SELECT track_count FROM ${marker}) > 1`,
    ).bind(operationId, operationId, operationId),
    env.DB.prepare(
      `DELETE FROM recommendation_buckets
       WHERE generation = (SELECT generation FROM ${marker})
         AND bucket_artist_id = (SELECT bucket_artist_id FROM ${marker})
         AND (SELECT track_count FROM ${marker}) = 1`,
    ).bind(operationId, operationId, operationId),
    env.DB.prepare(
      `UPDATE recommendation_buckets
       SET bucket_slot = (SELECT bucket_slot FROM ${marker})
       WHERE generation = (SELECT generation FROM ${marker})
         AND bucket_artist_id = (SELECT last_bucket_artist_id FROM ${marker})
         AND (SELECT track_count FROM ${marker}) = 1`,
    ).bind(operationId, operationId, operationId, operationId),
    env.DB.prepare(
      `UPDATE refresh_state
       SET candidate_count = MAX(candidate_count - 1, 0),
           live_bucket_count = MAX(live_bucket_count - CASE
             WHEN (SELECT track_count FROM ${marker}) = 1 THEN 1 ELSE 0 END, 0)
       WHERE singleton = 1
         AND live_generation = (SELECT generation FROM ${marker})`,
    ).bind(operationId, operationId),
    env.DB.prepare("DELETE FROM recommendation_pool_removals WHERE operation_id = ?").bind(operationId),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

function readGap(job: RebuildJobRow, reads: number): number {
  return reads > 0 ? Math.ceil(Math.max(MIN_READ_GAP_SECONDS, reads) * job.pace_multiplier) : 0;
}

async function finishUnit(env: Env, job: RebuildJobRow, performedDataRead: boolean | number): Promise<AdvanceOutcome> {
  const reads = Number(performedDataRead);
  const delaySeconds = readGap(job, reads);
  const successes = reads ? job.pace_successes + 1 : job.pace_successes;
  const recovered = Object.entries(job.usage ?? {}).some(([endpoint, count]) => endpoint !== 'token'
    && (!job.quota_endpoint || endpoint === job.quota_endpoint) && count.succeeded > 0) ? 1 : 0;
  const multiplier = successes >= 20 ? Math.max(1, job.pace_multiplier * 0.9) : job.pace_multiplier;
  if (job.fair_scheduler && job.work_key && ["artist_albums", "album_tracks", "enrich"].includes(job.phase)) {
    // Artist cursors live on their own rows, so yielding cannot lose paging or
    // partial enrichment. A failed unit keeps its current retry/checkpoint.
    await env.DB.batch([
      env.DB.prepare(`UPDATE rebuild_seed_artists SET turns = turns + 1 WHERE generation = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
        .bind(job.generation, job.work_key, ...jobMutationBindings(job)),
      jobStatement(env, job, { phase: "artist_albums", cursor: null, work_key: null }),
    ]);
    Object.assign(job, { phase: "artist_albums", cursor: null, work_key: null });
  }
  await env.DB.prepare(
    `UPDATE rebuild_jobs SET lease_until = NULL, retry_at = NULL, wait_reason = NULL, retry_count = 0,
     next_read_at = CASE WHEN ? THEN ? ELSE next_read_at END, pace_multiplier = ?, pace_successes = ?, retry_source = NULL,
     quota_last_recovery_at = CASE WHEN ? AND quota_attempts > 0 THEN ? ELSE quota_last_recovery_at END,
     quota_last_wait_ms = CASE WHEN ? AND quota_wait_started_at IS NOT NULL THEN ? - quota_wait_started_at ELSE quota_last_wait_ms END,
     quota_attempts = CASE WHEN ? THEN 0 ELSE quota_attempts END,
     quota_wait_started_at = CASE WHEN ? THEN NULL ELSE quota_wait_started_at END,
     quota_endpoint = CASE WHEN ? THEN NULL ELSE quota_endpoint END,
     revision = revision + 1, dispatch_pending = 1, updated_at = ? WHERE singleton = 1 AND generation = ? AND revision = ?`,
  ).bind(reads ? 1 : 0, now() + delaySeconds * 1000, multiplier, successes >= 20 ? 0 : successes, recovered, now(), recovered, now(), recovered, recovered, recovered, now(), job.generation, job.revision).run();
  if (reads) console.log(JSON.stringify({ event: "rebuild_unit", phase: job.phase, spotify_reads: reads, delay_seconds: delaySeconds }));
  return { kind: "scheduled", delaySeconds };
}

function warningIncrement(env: Env, field: keyof WarningCounts, amount = 1): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE refresh_state SET warnings_json = json_set(warnings_json, '$.${field}', COALESCE(json_extract(warnings_json, '$.${field}'), 0) + ?) WHERE singleton = 1`,
  ).bind(amount);
}

function logSkip(job: RebuildJobRow, object: string, spotifyId: string, status: number): void {
  console.log(JSON.stringify({ event: "rebuild_object_skipped", phase: job.phase, object, spotify_id: spotifyId, reason: status === 403 ? "forbidden" : "not_found", status }));
}

type StagedRecordingRow = Omit<Recording, "artists"> & { generation: string; artists_json: string };
type LearnedRecordingIdentity = { spotifyId: string; isrc: string };

function learnedRecordingIdentities(requestedId: string, track: unknown): LearnedRecordingIdentity[] {
  if (!track || typeof track !== "object") return [];
  const value = track as { id?: unknown; linked_from?: { id?: unknown } | null; external_ids?: { isrc?: unknown } | null };
  const isrc = normalizeIsrc(value.external_ids?.isrc);
  if (!isrc) return [];
  // A market-specific lookup can relink requested id A to playable id B. The
  // 2026 Development Mode shape removes linked_from, so the requested id is
  // deliberately retained even when only B is present in the response.
  const aliases = new Set([requestedId]);
  if (isTrackId(value.id)) aliases.add(value.id);
  if (isTrackId(value.linked_from?.id)) aliases.add(value.linked_from.id);
  return [...aliases].map((spotifyId) => ({ spotifyId, isrc }));
}

function neverAliasStatements(env: Env, identities: LearnedRecordingIdentity[]): D1PreparedStatement[] {
  const unique = [...new Map(identities.map((identity) => [`${identity.isrc}:${identity.spotifyId}`, identity])).values()];
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < unique.length; start += NEVER_IDENTITY_BATCH_LIMIT) {
    const chunk = unique.slice(start, start + NEVER_IDENTITY_BATCH_LIMIT);
    const values = chunk.map(() => "(?, ?)").join(", ");
    const bindings = chunk.flatMap((identity) => [identity.isrc, identity.spotifyId]);
    statements.push(env.DB.prepare(
      `WITH identities(isrc, spotify_id) AS (VALUES ${values})
       UPDATE never_recordings
       SET isrc = (
         SELECT i.isrc FROM identities i
         WHERE i.spotify_id = never_recordings.spotify_id
         ORDER BY i.isrc LIMIT 1
       )
       WHERE isrc IS NULL
         AND EXISTS (
           SELECT 1 FROM identities i
           WHERE i.spotify_id = never_recordings.spotify_id
         )`,
    ).bind(...bindings));
  }
  return statements;
}

function rowToRecording(row: StagedRecordingRow): Recording {
  let artists: Recording["artists"] = [];
  try {
    const parsed = JSON.parse(row.artists_json) as unknown;
    if (Array.isArray(parsed)) artists = parsed.filter((credit): credit is Recording["artists"][number] => Boolean(credit && typeof credit === "object" && typeof (credit as Recording["artists"][number]).id === "string" && typeof (credit as Recording["artists"][number]).name === "string"));
  } catch {
    artists = [];
  }
  return { ...row, artists };
}

/** Stage recordings for this generation, keeping one representative per recording key. */
async function stageRecordings(env: Env, job: RebuildJobRow, rows: Recording[], learnedIdentities: LearnedRecordingIdentity[]): Promise<void> {
  // One batch can contain several Spotify ids for the same recording (for
  // example the album and single versions sharing an ISRC); reduce them to
  // their best representative before touching D1 so the primary key holds.
  const batch = new Map<string, Recording>();
  for (const row of rows) {
    const current = batch.get(row.recording_key);
    if (!current || compareRepresentatives(row, current) < 0) batch.set(row.recording_key, row);
  }
  const keys = [...batch.keys()];
  const live = rows.length
    ? await env.DB.prepare("SELECT live_generation FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null }>()
    : null;
  const existing = keys.length
    ? await env.DB.prepare(
      `SELECT generation, recording_key, spotify_id, isrc, title, album_name, release_date, image_url, spotify_url, artists_json, bucket_artist_id FROM recordings WHERE generation IN (?, ?) AND recording_key IN (${keys.map(() => "?").join(", ")})`,
    ).bind(job.generation, live?.live_generation ?? job.generation, ...keys).all<StagedRecordingRow>()
    : { results: [] as StagedRecordingRow[] };
  const existingByKey = new Map(existing.results.filter(row => row.generation === job.generation).map(row => [row.recording_key, rowToRecording(row)]));
  const publicKeys = new Set(existing.results.filter(row => row.generation === live?.live_generation).map(row => row.recording_key));
  const publicationKeys = keys.filter(key => !publicKeys.has(key));
  const generationIsLive = live?.live_generation === job.generation;
  // v3 Never rows knew only a Spotify id. The first matching v4 enrichment
  // teaches that permanent exclusion its canonical ISRC key, so a later
  // Spotify representative of the same recording remains excluded too.
  const statements = [...neverAliasStatements(env, learnedIdentities), ...knownIdentityStatements(env, job, learnedIdentities)];
  const selected: (Recording & { artists_json: string })[] = [];
  for (const row of batch.values()) {
    const current = existingByKey.get(row.recording_key);
    // Bootstrap rows become visible before discovery finishes. Keep any
    // representative a visitor could already be holding stable; subsequent
    // batches may grow the shelf but cannot invalidate that card's Spotify id.
    if (current && generationIsLive) continue;
    if (current && compareRepresentatives(row, current) >= 0) continue;
    selected.push({ ...row, artists_json: JSON.stringify(row.artists) });
  }
  if (selected.length) statements.push(progressStatement(env, job, { stagedRecordings: {
    sql: `SELECT count(*) FROM json_each(?) item WHERE NOT EXISTS (
      SELECT 1 FROM recordings r WHERE r.generation = ? AND r.recording_key = json_extract(item.value, '$.recording_key'))
      AND NOT EXISTS (SELECT 1 FROM rebuild_known_recordings k WHERE k.generation = ? AND k.recording_key = json_extract(item.value, '$.recording_key'))`,
    bindings: [JSON.stringify(selected), job.generation, job.generation],
  } }), env.DB.prepare(`
    INSERT INTO recordings (generation, recording_key, spotify_id, isrc, title, album_name, release_date, image_url, spotify_url, artists_json, bucket_artist_id)
    SELECT ?, json_extract(value, '$.recording_key'), json_extract(value, '$.spotify_id'), json_extract(value, '$.isrc'),
      json_extract(value, '$.title'), json_extract(value, '$.album_name'), json_extract(value, '$.release_date'),
      json_extract(value, '$.image_url'), json_extract(value, '$.spotify_url'), json_extract(value, '$.artists_json'), json_extract(value, '$.bucket_artist_id')
    FROM json_each(?) WHERE ${JOB_MUTATION_GUARD}
      AND NOT EXISTS (SELECT 1 FROM rebuild_known_recordings k WHERE k.generation = ? AND k.recording_key = json_extract(value, '$.recording_key'))
    ON CONFLICT(generation, recording_key) DO UPDATE SET spotify_id = excluded.spotify_id, isrc = excluded.isrc,
      title = excluded.title, album_name = excluded.album_name, release_date = excluded.release_date, image_url = excluded.image_url,
      spotify_url = excluded.spotify_url, artists_json = excluded.artists_json, bucket_artist_id = excluded.bucket_artist_id
  `).bind(job.generation, JSON.stringify(selected), ...jobMutationBindings(job), job.generation));
  if (publicationKeys.length && live?.live_generation && !generationIsLive) {
    statements.push(...artistPublicationStatements(env, job, live.live_generation, job.work_key ?? rows[0]!.bucket_artist_id, publicationKeys));
  }
  if (statements.length) {
    await env.DB.batch(statements);
  }
  if (!rows.length) return;
  if (!live?.live_generation) {
    await publishBootstrapGeneration(env, job);
  } else if (generationIsLive) {
    await appendRecommendationPool(env, job.generation, job.work_key ?? rows[0]?.bucket_artist_id ?? "", job);
  }
}

/**
 * A first install has no old shelf to protect. Once the initial known-track
 * scans have completed, expose the first eligible discovery results and let
 * that same generation keep growing while the job continues. Later rebuilds
 * publish validated batches while preserving their replacement gate.
 */
async function publishBootstrapGeneration(env: Env, job: RebuildJobRow): Promise<void> {
  const timestamp = now();
  await env.DB.batch([
    // Build and conditionally publish in one transaction. An owner exclusion
    // can therefore linearize only before the materialization (and be filtered)
    // or after the generation is visibly live (and compact it there).
    // Every visible mutation also checks the revision acquired by this queue
    // delivery. D1 executes the batch transactionally, so a migration or
    // replacement job linearizes either before the whole publication (all
    // statements become no-ops) or after it (and can safely reroute it).
    ...recommendationPoolStatements(env, job.generation, job),
    env.DB.prepare(
      `INSERT OR IGNORE INTO recording_generations (generation, promoted_at)
       SELECT ?, ?
       WHERE ${JOB_MUTATION_GUARD}
         AND (SELECT live_generation FROM refresh_state WHERE singleton = 1) IS NULL
         AND EXISTS (SELECT 1 FROM recommendation_slots WHERE generation = ? LIMIT 1)`,
    ).bind(job.generation, timestamp, ...jobMutationBindings(job), job.generation),
    env.DB.prepare(
      `UPDATE refresh_state
       SET live_generation = ?, refreshed_at = ?,
           candidate_count = (SELECT COUNT(*) FROM recommendation_slots WHERE generation = ?),
           live_bucket_count = (SELECT COUNT(*) FROM recommendation_buckets WHERE generation = ?)
       WHERE singleton = 1 AND live_generation IS NULL
         AND ${JOB_MUTATION_GUARD}
         AND EXISTS (SELECT 1 FROM recommendation_slots WHERE generation = ? LIMIT 1)`,
    ).bind(job.generation, timestamp, job.generation, job.generation, ...jobMutationBindings(job), job.generation),
  ]);
}

async function preflightUnit(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  const token = await accessToken(env, job, true);
  const granted = new Set(token.scope.split(/\s+/));
  const missing = SERVICE_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) throw new RefreshFailure("preflight scopes", 403, `service token is missing Spotify scopes: ${missing.join(" ")}`);
  const response = await spotifyData("https://api.spotify.com/v1/me", token, "preflight account", env);
  const profile = await response.json() as { id?: unknown; account_id?: unknown; country?: unknown };
  if (typeof profile.id !== "string" || !profile.id || typeof profile.account_id !== "string" || !profile.account_id) {
    throw new RefreshFailure("preflight account", 502, "Spotify returned a malformed profile");
  }
  if (profile.account_id !== env.OWNER_SPOTIFY_ID) throw new RefreshFailure("preflight account", 403, "service token belongs to a different Spotify account");
  const market = typeof profile.country === "string" && /^[A-Z]{2}$/.test(profile.country) ? profile.country : null;
  await setJob(env, job, { phase: "never_identities", market, owner_user_id: profile.id, cursor: null, work_key: null });
  return finishUnit(env, job, token.reads);
}

/**
 * Resolve permanent exact-id exclusions before catalogue discovery. Spotify's
 * 2026 Development Mode Track shape omits linked_from, so album discovery
 * alone cannot reliably connect a relinked id B to an old Never id A. Looking
 * up A directly preserves the request identity while the response supplies the
 * canonical ISRC (and potentially B). Unresolved ids are checked at most once
 * per rebuild and retried by a later weekly generation.
 */
async function neverIdentitiesUnit(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  const pending = await env.DB.prepare(
    `SELECT n.spotify_id
     FROM never_recordings n
     WHERE n.isrc IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM never_recordings resolved
         WHERE resolved.spotify_id = n.spotify_id AND resolved.isrc IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM never_identity_checks c
         WHERE c.spotify_id = n.spotify_id AND c.checked_at >= ?
       )
     ORDER BY n.spotify_id
     LIMIT ?`,
  ).bind(job.started_at, enrichmentLimit(job)).all<{ spotify_id: string }>();
  if (!pending.results.length) {
    await setJob(env, job, { phase: "seeds", cursor: LIKED_URL, work_key: null });
    return finishUnit(env, job, false);
  }

  const validIds = pending.results.map((row) => row.spotify_id).filter(isTrackId);
  const { fetched, performedDataRead, failure } = await fetchTracks(env, job, validIds, "Never identity");
  const completedIds = new Set(fetched.map((result) => result.id));
  const completed = pending.results.filter((row) => !isTrackId(row.spotify_id) || completedIds.has(row.spotify_id));
  const timestamp = now();
  const checkValues = completed.map(() => "(?, ?)").join(", ");
  const checkBindings = completed.flatMap((row) => [row.spotify_id, timestamp]);
  if (completed.length) await env.DB.batch([
    ...neverAliasStatements(env, fetched.flatMap(({ id, track }) => learnedRecordingIdentities(id, track))),
    env.DB.prepare(
      `INSERT INTO never_identity_checks (spotify_id, checked_at) VALUES ${checkValues}
       ON CONFLICT(spotify_id) DO UPDATE SET checked_at = excluded.checked_at`,
    ).bind(...checkBindings),
  ]);
  for (const result of fetched) {
    if (result.skippedStatus) logSkip(job, "Never identity", result.id, result.skippedStatus);
  }
  if (failure !== null) throw failure;
  return finishUnit(env, job, performedDataRead);
}

async function seedsUnit(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  const token = await accessToken(env, job);
  const page = await spotifyPage<SpotifySavedTrack>(job.cursor ?? LIKED_URL, token, "liked tracks", env);
  const seedIds: string[] = [];
  for (const entry of page.items) {
    // Only the first credited artist of each liked track becomes a seed.
    const seed = entry?.track?.artists?.[0];
    if (typeof seed?.id === "string" && seed.id) seedIds.push(seed.id);
  }
  const changes: JobChanges = page.next ? { cursor: page.next } : { phase: "known_playlists", cursor: PLAYLISTS_URL, work_key: null };
  const statements = [
    progressStatement(env, job, {
      seedArtists: { sql: "SELECT count(*) FROM json_each(?) s WHERE NOT EXISTS (SELECT 1 FROM rebuild_seed_artists a WHERE a.generation = ? AND a.spotify_id = s.value)", bindings: [JSON.stringify([...new Set(seedIds)]), job.generation] },
      likedTracksScanned: page.items.length, ...(!page.next ? { seedScanComplete: 1 } : {}),
    }),
    env.DB.prepare(`INSERT OR IGNORE INTO rebuild_seed_artists (generation, spotify_id)
      SELECT ?, value FROM json_each(?) WHERE ${JOB_MUTATION_GUARD}`).bind(job.generation, JSON.stringify([...new Set(seedIds)]), ...jobMutationBindings(job)),
    ...knownTrackStatements(env, job, knownTracks(page.items.map((entry) => entry?.track))),
  ];
  await env.DB.batch([...statements, jobStatement(env, job, changes)]);
  Object.assign(job, changes);
  return finishUnit(env, job, token.reads);
}

type SeedArtist = { spotify_id: string; cursor: string | null; status: string; admitted: number };

async function nextFairArtist(env: Env, job: RebuildJobRow): Promise<SeedArtist | null> {
  const active = (await env.DB.prepare("SELECT count(*) AS count FROM rebuild_seed_artists WHERE generation=? AND admitted=1")
    .bind(job.generation).first<CountRow>())?.count ?? 0;
  let queuedRead: Promise<SeedArtist | null> | undefined;
  const queuedArtist = () => queuedRead ??= env.DB.prepare(`SELECT a.spotify_id,a.cursor,a.status,a.admitted FROM rebuild_seed_artists a
    WHERE a.generation=? AND a.admitted=1 AND (
      EXISTS(SELECT 1 FROM rebuild_enrich_queue q WHERE q.generation=a.generation AND q.bucket_artist_id=a.spotify_id)
      OR EXISTS(SELECT 1 FROM rebuild_album_queue q WHERE q.generation=a.generation AND q.bucket_artist_id=a.spotify_id AND q.status='pending'))
    ORDER BY a.turns,a.spotify_id LIMIT 1`).bind(job.generation).first<SeedArtist>();
  if (active < ARTIST_WORKING_SET) {
    if (job.priority_new_artists) {
      // Upgraded jobs can already have hundreds of queued releases. Prefer an
      // artist whose discovery has started before spending quota on more lists.
      // The turns range uses artist_working_set and skips untouched seed rows.
      const started = await env.DB.prepare(`SELECT a.spotify_id,a.cursor,a.status,a.admitted FROM rebuild_seed_artists a
        WHERE a.generation=? AND a.admitted=0 AND a.turns>0 AND NOT EXISTS(SELECT 1 FROM recommendation_buckets b
          WHERE b.generation=(SELECT live_generation FROM refresh_state WHERE singleton=1) AND b.bucket_artist_id=a.spotify_id)
        ORDER BY a.turns,a.spotify_id LIMIT 1`).bind(job.generation).first<SeedArtist>();
      if (started) return started;
      const queued = job.quota_attempts > 0 ? await queuedArtist() : null;
      if (queued) return queued;
      const novel = await env.DB.prepare(`SELECT a.spotify_id,a.cursor,a.status,a.admitted FROM rebuild_seed_artists a
        WHERE a.generation=? AND a.admitted=0 AND NOT EXISTS(SELECT 1 FROM recommendation_buckets b
          WHERE b.generation=(SELECT live_generation FROM refresh_state WHERE singleton=1) AND b.bucket_artist_id=a.spotify_id)
        ORDER BY a.turns,a.spotify_id LIMIT 1`).bind(job.generation).first<SeedArtist>();
      if (novel) return novel;
      // A warm refresh can have thousands of existing artists. Once the novel
      // pass is exhausted, never repeat that unsuccessful scan on every turn.
      await env.DB.prepare(`UPDATE rebuild_jobs SET priority_new_artists=0 WHERE singleton=1 AND ${JOB_MUTATION_GUARD}`)
        .bind(...jobMutationBindings(job)).run();
      job.priority_new_artists = 0;
    }
    const started = await env.DB.prepare("SELECT spotify_id,cursor,status,admitted FROM rebuild_seed_artists WHERE generation=? AND admitted=0 AND turns>0 ORDER BY turns,spotify_id LIMIT 1")
      .bind(job.generation).first<SeedArtist>();
    if (started) return started;
    const queued = job.quota_attempts > 0 ? await queuedArtist() : null;
    if (queued) return queued;
    const next = await env.DB.prepare("SELECT spotify_id,cursor,status,admitted FROM rebuild_seed_artists WHERE generation=? AND admitted=0 ORDER BY turns,spotify_id LIMIT 1")
      .bind(job.generation).first<SeedArtist>();
    if (next) return next;
  }
  if (job.quota_attempts > 0) {
    const queued = await queuedArtist();
    if (queued) return queued;
  }
  return env.DB.prepare("SELECT spotify_id,cursor,status,admitted FROM rebuild_seed_artists WHERE generation=? AND admitted=1 ORDER BY turns,spotify_id LIMIT 1")
    .bind(job.generation).first<SeedArtist>();
}

async function artistAlbumsUnit(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  // After the wait expires, use queued songs/releases before retrying a cold
  // release-list request. Artist pagination already lives on each seed row.
  const resumeDiscovery = job.fair_scheduler && job.quota_attempts > 0;
  const entry = job.work_key && !resumeDiscovery
    ? await env.DB.prepare("SELECT spotify_id, cursor, status, admitted FROM rebuild_seed_artists WHERE generation = ? AND spotify_id = ? LIMIT 1").bind(job.generation, job.work_key).first<{ spotify_id: string; cursor: string | null; status: string; admitted: number }>()
    : job.fair_scheduler ? await nextFairArtist(env, job)
      : await env.DB.prepare("SELECT spotify_id,cursor,status,admitted FROM rebuild_seed_artists WHERE generation=? AND status='pending' ORDER BY spotify_id LIMIT 1")
        .bind(job.generation).first<SeedArtist>();
  if (entry && job.work_key && job.work_key !== entry.spotify_id) await setJob(env, job, { work_key: entry.spotify_id, cursor: null });
  if (entry && job.fair_scheduler && !entry.admitted) {
    await env.DB.prepare(`UPDATE rebuild_seed_artists SET admitted=1 WHERE generation=? AND spotify_id=? AND ${JOB_MUTATION_GUARD}`)
      .bind(job.generation, entry.spotify_id, ...jobMutationBindings(job)).run();
  }
  if (entry && job.fair_scheduler) {
    const work = await env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM rebuild_enrich_queue WHERE generation = ? AND bucket_artist_id = ?) AS enrich,
      EXISTS(SELECT 1 FROM rebuild_album_queue WHERE generation = ? AND bucket_artist_id = ?) AS albums`)
      .bind(job.generation, entry.spotify_id, job.generation, entry.spotify_id).first<{ enrich: number; albums: number }>();
    if (work?.enrich || work?.albums) {
      await setJob(env, job, { phase: work.enrich ? "enrich" : "album_tracks", cursor: null, work_key: entry.spotify_id });
      // Execute a bounded useful unit in the same turn; selection alone must
      // not consume another artist turn or starve pending work.
      return work.enrich ? enrichUnit(env, job) : albumTracksUnit(env, job);
    }
    if (entry.status === "catalogued") {
      await setJob(env, job, { work_key: entry.spotify_id });
      await completeArtist(env, job);
      return finishUnit(env, job, false);
    }
  }
  if (entry?.status === "catalogued") {
    await setJob(env, job, { phase: "album_tracks", cursor: null, work_key: entry.spotify_id });
    return finishUnit(env, job, false);
  }
  if (entry && entry.status !== "pending") {
    await setJob(env, job, { phase: "artist_albums", cursor: null, work_key: null });
    return finishUnit(env, job, false);
  }
  if (!entry && job.work_key) {
    // A skipped artist row is deleted before this job cursor is cleared. If an
    // invocation is interrupted in that tiny window, clear the stale key and
    // resume pending-artist selection instead of mistaking it for end-of-work.
    await setJob(env, job, { phase: "artist_albums", cursor: null, work_key: null });
    return finishUnit(env, job, false);
  }
  if (!entry) {
    await setJob(env, job, { phase: "known_liked", cursor: LIKED_URL, work_key: null });
    return finishUnit(env, job, false);
  }
  if (!job.work_key) await setJob(env, job, { work_key: entry.spotify_id });
  const token = await accessToken(env, job);
  try {
    const page = await spotifyPage<SpotifyAlbum>(entry.cursor ?? artistAlbumsUrl(entry.spotify_id), token, "artist releases", env);
    const statements: D1PreparedStatement[] = page.items
      .filter((album): album is SpotifyAlbum & { id: string; name: string } => typeof album?.id === "string" && album.id !== "" && typeof album.name === "string" && album.name !== "")
      .map((album) => env.DB.prepare("INSERT OR IGNORE INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name, image_url) VALUES (?, ?, ?, ?, ?)").bind(job.generation, album.id, entry.spotify_id, album.name, typeof album.images?.[0]?.url === "string" ? album.images[0].url : null));
    statements.push(env.DB.prepare(page.next
      ? "UPDATE rebuild_seed_artists SET cursor = ? WHERE generation = ? AND spotify_id = ?"
      : "UPDATE rebuild_seed_artists SET status = 'catalogued', cursor = NULL WHERE generation = ? AND spotify_id = ?")
      .bind(...(page.next ? [page.next, job.generation, entry.spotify_id] : [job.generation, entry.spotify_id])));
    await env.DB.batch(statements);
    if (!page.next) await setJob(env, job, { phase: "album_tracks", cursor: null, work_key: entry.spotify_id });
  } catch (cause) {
    if (!expectedSkip(cause)) throw cause;
    // A later page can disappear after earlier pages already queued releases.
    // Preserve and process that partial discovery instead of orphaning its
    // album rows under an artist key the state machine will never revisit.
    await env.DB.batch([
      env.DB.prepare("UPDATE rebuild_seed_artists SET status = 'catalogued', cursor = NULL, skip_reason = ? WHERE generation = ? AND spotify_id = ?").bind(cause.status === 403 ? "forbidden" : "not_found", job.generation, entry.spotify_id),
      warningIncrement(env, "artistsUnavailable"),
    ]);
    logSkip(job, "artist", entry.spotify_id, cause.status);
    await setJob(env, job, { phase: "album_tracks", cursor: null, work_key: entry.spotify_id });
  }
  return finishUnit(env, job, token.reads);
}

async function albumTracksUnit(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  if (!job.work_key) {
    await setJob(env, job, { phase: "artist_albums", cursor: null, work_key: null });
    return finishUnit(env, job, false);
  }
  const entry = await env.DB.prepare("SELECT spotify_id, cursor, bucket_artist_id FROM rebuild_album_queue WHERE generation = ? AND bucket_artist_id = ? AND status = 'pending' ORDER BY spotify_id LIMIT 1").bind(job.generation, job.work_key).first<{ spotify_id: string; cursor: string | null; bucket_artist_id: string }>();
  if (!entry) {
    const pendingEnrichment = (await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_enrich_queue WHERE generation = ? AND bucket_artist_id = ?").bind(job.generation, job.work_key).first<CountRow>())?.count ?? 0;
    if (pendingEnrichment > 0) {
      await setJob(env, job, { phase: "enrich", cursor: null });
    } else {
      await completeArtist(env, job);
    }
    return finishUnit(env, job, false);
  }
  const context = await catalogueContext(env, job.market);
  const cursor = entry.cursor ?? albumTracksUrl(entry.spotify_id, job.market);
  let reads = 0;
  try {
    const cached = await readAlbumPage(env, context, entry.spotify_id, cursor);
    let discovered: { ids: string[]; next: string | null };
    let availability: D1PreparedStatement[] = [];
    if (cached) {
      discovered = cached;
      console.log(JSON.stringify({ event: "rebuild_album_page_reused" }));
    } else {
      const token = await accessToken(env, job);
      const page = await spotifyPage<SpotifyTrackStub>(cursor, token, "release tracks", env);
      reads = token.reads;
      discovered = { ids: page.items.map((track) => isTrackId(track?.linked_from?.id) ? track.linked_from.id : track?.id).filter(isTrackId), next: page.next };
      availability = albumAvailabilityStatements(env, job, context, entry.spotify_id, cursor, page.items);
    }
    const discoveredIds = [...new Set(discovered.ids)];
    const ids = await unknownTrackIds(env, job.generation, discoveredIds);
    const skippedKnown = discoveredIds.length - ids.length;
    const statements: D1PreparedStatement[] = [progressStatement(env, job, {
      tracksDiscovered: discoveredIds.length, tracksProcessed: skippedKnown, tracksKnown: skippedKnown,
    }, "EXISTS (SELECT 1 FROM rebuild_album_queue WHERE generation = ? AND spotify_id = ? AND cursor IS ?)", [job.generation, entry.spotify_id, entry.cursor])];
    if (!cached) statements.push(albumPageStatement(env, job, context, entry.spotify_id, cursor, discovered.ids, discovered.next), ...availability);
    if (ids.length) {
      const start = (await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM rebuild_enrich_queue WHERE generation = ?").bind(job.generation).first<{ seq: number }>())?.seq ?? 1;
      for (let index = 0; index < ids.length; index += ENRICH_BATCH_LIMIT) {
        const group = ids.slice(index, index + ENRICH_BATCH_LIMIT);
        statements.push(env.DB.prepare(`INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json)
          SELECT ?, ?, ?, ? WHERE ${JOB_MUTATION_GUARD}`)
          .bind(job.generation, start + index / ENRICH_BATCH_LIMIT, entry.bucket_artist_id, JSON.stringify(group), ...jobMutationBindings(job)));
      }
    }
    statements.push(env.DB.prepare(discovered.next
      ? `UPDATE rebuild_album_queue SET cursor = ? WHERE generation = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`
      : `DELETE FROM rebuild_album_queue WHERE generation = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
      .bind(...(discovered.next ? [discovered.next, job.generation, entry.spotify_id] : [job.generation, entry.spotify_id]), ...jobMutationBindings(job)));
    await env.DB.batch(statements);
    const skipped = skippedKnown;
    if (skipped) console.log(JSON.stringify({ event: "rebuild_known_tracks_skipped", count: skipped }));
  } catch (cause) {
    if (!expectedSkip(cause)) throw cause;
    reads = Math.max(1, reads);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rebuild_album_queue WHERE generation = ? AND spotify_id = ?").bind(job.generation, entry.spotify_id),
      warningIncrement(env, "albumsUnavailable"),
    ]);
    logSkip(job, "album", entry.spotify_id, cause.status);
  }
  return finishUnit(env, job, reads);
}

async function enrichUnit(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  if (!job.work_key) {
    await setJob(env, job, { phase: "artist_albums", cursor: null, work_key: null });
    return finishUnit(env, job, false);
  }
  const batch = await env.DB.prepare("SELECT seq, bucket_artist_id, track_ids_json FROM rebuild_enrich_queue WHERE generation = ? AND bucket_artist_id = ? ORDER BY seq LIMIT 1").bind(job.generation, job.work_key).first<{ seq: number; bucket_artist_id: string; track_ids_json: string }>();
  if (!batch) {
    const pendingAlbum = await env.DB.prepare("SELECT spotify_id FROM rebuild_album_queue WHERE generation = ? AND bucket_artist_id = ? AND status = 'pending' LIMIT 1").bind(job.generation, job.work_key).first<{ spotify_id: string }>();
    if (pendingAlbum) {
      await setJob(env, job, { phase: "album_tracks", cursor: null });
    } else {
      await completeArtist(env, job);
    }
    return finishUnit(env, job, false);
  }
  let queuedIds: string[] = [];
  try {
    const parsed = JSON.parse(batch.track_ids_json) as unknown;
    if (Array.isArray(parsed)) queuedIds = [...new Set(parsed.filter(isTrackId))];
  } catch {
    queuedIds = [];
  }
  // Enforce the limit again at consumption time so queue rows created by an
  // older deployment (or repaired by hand) cannot exceed the current budget.
  const considered = queuedIds.slice(0, enrichmentLimit(job));
  const ids = await unknownTrackIds(env, job.generation, considered);
  const knownIds = considered.filter((id) => !ids.includes(id));
  if (knownIds.length) console.log(JSON.stringify({ event: "rebuild_known_tracks_skipped", count: knownIds.length }));
  const { fetched, performedDataRead, failure } = await fetchTracks(env, job, ids, "track enrichment");
  const learnedIdentities = fetched.flatMap(({ id, track }) => learnedRecordingIdentities(id, track));
  const rows = fetched
    .map(({ track }) => track === null ? null : toRecording(track as Parameters<typeof toRecording>[0], batch.bucket_artist_id))
    .filter((row): row is Recording => row !== null);
  await stageRecordings(env, job, rows, learnedIdentities);
  const completedIds = new Set([...knownIds, ...fetched.map((result) => result.id)]);
  // Includes failed and not-yet-requested ids, plus oversized legacy-row tails.
  const remainingIds = queuedIds.filter((id) => !completedIds.has(id));
  const skipped = fetched.filter((result): result is typeof result & { skippedStatus: number } => result.skippedStatus !== undefined);
  const guard = `AND ${JOB_MUTATION_GUARD}`;
  const queueMutation = remainingIds.length
    ? env.DB.prepare(`UPDATE rebuild_enrich_queue SET track_ids_json = ? WHERE generation = ? AND seq = ? ${guard}`)
      .bind(JSON.stringify(remainingIds), job.generation, batch.seq, ...jobMutationBindings(job))
    : env.DB.prepare(`DELETE FROM rebuild_enrich_queue WHERE generation = ? AND seq = ? ${guard}`)
      .bind(job.generation, batch.seq, ...jobMutationBindings(job));
  // Commit partial progress before deferring a quota/rate/server failure.
  // If staging was interrupted, cached successes can be replayed idempotently.
  await env.DB.batch([
    progressStatement(env, job, { tracksProcessed: completedIds.size, tracksKnown: knownIds.length,
      tracksCached: fetched.filter((result) => result.cached).length,
      tracksFetched: fetched.filter((result) => !result.cached).length,
    }, "EXISTS (SELECT 1 FROM rebuild_enrich_queue WHERE generation = ? AND seq = ? AND track_ids_json = ?)", [job.generation, batch.seq, batch.track_ids_json]),
    ...(skipped.length ? [env.DB.prepare(
      `UPDATE refresh_state SET warnings_json = json_set(warnings_json, '$.trackBatchesUnavailable',
       COALESCE(json_extract(warnings_json, '$.trackBatchesUnavailable'), 0) + ?)
       WHERE singleton = 1 AND ${JOB_MUTATION_GUARD}`,
    ).bind(skipped.length, ...jobMutationBindings(job))] : []),
    queueMutation,
  ]);
  for (const result of skipped) logSkip(job, "track", result.id, result.skippedStatus);
  if (failure !== null) throw failure;
  return finishUnit(env, job, performedDataRead);
}

async function knownLikedUnit(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  const token = await accessToken(env, job);
  const page = await spotifyPage<SpotifySavedTrack>(job.cursor ?? LIKED_URL, token, "known liked tracks", env);
  const statements = knownTrackStatements(env, job, knownTracks(page.items.map((entry) => entry?.track)));
  if (statements.length) await env.DB.batch(statements);
  await setJob(env, job, page.next ? { cursor: page.next } : { phase: "promote", cursor: null, work_key: null });
  return finishUnit(env, job, token.reads);
}

async function knownPlaylistsUnit(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  const token = await accessToken(env, job);
  const page = await spotifyPage<SpotifyPlaylist>(job.cursor ?? PLAYLISTS_URL, token, "playlist discovery", env);
  const context = await catalogueContext(env, job.market);
  const playlists: { id: string; snapshot: string | null }[] = [];
  let foreign = 0;
  for (const playlist of page.items) {
    if (typeof playlist?.id !== "string" || !playlist.id) continue;
    if (playlist.owner?.id !== job.owner_user_id && playlist.collaborative !== true) { foreign += 1; continue; }
    playlists.push({ id: playlist.id, snapshot: typeof playlist.snapshot_id === "string" && playlist.snapshot_id ? playlist.snapshot_id : null });
  }
  if (foreign) console.log(JSON.stringify({ event: "rebuild_playlists_filtered", phase: job.phase, count: foreign, reason: "not_owner_or_collaborative" }));
  const changes: JobChanges = page.next ? { cursor: page.next } : { phase: "known_playlist_items", cursor: null, work_key: null };
  const statements: D1PreparedStatement[] = [progressStatement(env, job, { playlists: {
    sql: "SELECT count(*) FROM (SELECT DISTINCT json_extract(value, '$.id') AS id FROM json_each(?)) p WHERE NOT EXISTS (SELECT 1 FROM rebuild_playlist_queue q WHERE q.generation = ? AND q.spotify_id = p.id)",
    bindings: [JSON.stringify(playlists), job.generation],
  } })];
  if (playlists.length) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO rebuild_playlist_queue (generation, spotify_id, snapshot_id, cache_context, status)
    SELECT ?, json_extract(p.value, '$.id'), json_extract(p.value, '$.snapshot'), ?,
      CASE WHEN EXISTS (SELECT 1 FROM playlist_snapshots s WHERE s.context = ? AND s.spotify_id = json_extract(p.value, '$.id')
        AND s.snapshot_id = json_extract(p.value, '$.snapshot') AND s.completed_at > ?) THEN 'reuse' ELSE 'pending' END
    FROM json_each(?) p WHERE ${JOB_MUTATION_GUARD}`)
    .bind(job.generation, context, context, now() - PLAYLIST_CACHE_TTL_MS, JSON.stringify(playlists), ...jobMutationBindings(job)));
  await env.DB.batch([...statements, jobStatement(env, job, changes)]);
  Object.assign(job, changes);
  return finishUnit(env, job, token.reads);
}

async function knownPlaylistItemsUnit(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  const entry = await env.DB.prepare(`SELECT spotify_id, cursor, status, snapshot_id, cache_context FROM rebuild_playlist_queue
    WHERE generation = ? AND status IN ('pending', 'reuse', 'verify') ORDER BY spotify_id LIMIT 1`)
    .bind(job.generation).first<{ spotify_id: string; cursor: string | null; status: string; snapshot_id: string | null; cache_context: string | null }>();
  if (!entry) {
    await setJob(env, job, { phase: "artist_albums", cursor: null, work_key: null });
    return finishUnit(env, job, false);
  }
  const remove = () => [
    progressStatement(env, job, { playlistsDone: 1 }, "EXISTS (SELECT 1 FROM rebuild_playlist_queue WHERE generation = ? AND spotify_id = ?)", [job.generation, entry.spotify_id]),
    env.DB.prepare(`DELETE FROM rebuild_playlist_queue WHERE generation = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
      .bind(job.generation, entry.spotify_id, ...jobMutationBindings(job)),
  ];
  if (entry.status === "reuse" && entry.snapshot_id && entry.cache_context) {
    let cached: NonNullable<Awaited<ReturnType<typeof readPlaylistPage>>>;
    try {
      const page = await readPlaylistPage(env, entry.cache_context, entry.spotify_id, entry.snapshot_id, entry.cursor);
      if (!page) throw new Error("Incomplete cached playlist");
      cached = page;
    } catch {
      // A corrupt cache is rescanned; it must not weaken known exclusions.
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM playlist_snapshots WHERE context = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
          .bind(entry.cache_context, entry.spotify_id, ...jobMutationBindings(job)),
        env.DB.prepare(`UPDATE rebuild_playlist_queue SET status = 'pending', cursor = NULL WHERE generation = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
          .bind(job.generation, entry.spotify_id, ...jobMutationBindings(job)),
      ]);
      return finishUnit(env, job, false);
    }
    const progress = cached.hasNext
      ? env.DB.prepare(`UPDATE rebuild_playlist_queue SET cursor = ? WHERE generation = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
        .bind(cached.pageKey, job.generation, entry.spotify_id, ...jobMutationBindings(job))
      : null;
    await env.DB.batch([...knownTrackStatements(env, job, cached.mappings),
      progressStatement(env, job, { playlistTracksScanned: cached.mappings.length }), ...(progress ? [progress] : remove())]);
    console.log(JSON.stringify({ event: "rebuild_playlist_page_reused" }));
    return finishUnit(env, job, false);
  }
  const token = await accessToken(env, job);
  try {
    if (entry.status === "verify" && entry.snapshot_id && entry.cache_context) {
      const response = await spotifyData(spotifyUrl(`playlists/${encodeURIComponent(entry.spotify_id)}`, { fields: "snapshot_id" }, job.market), token, "playlist snapshot", env);
      const current = await response.json<{ snapshot_id?: unknown }>();
      if (typeof current.snapshot_id !== "string" || !current.snapshot_id) throw new RefreshFailure("playlist snapshot", 502, "Spotify snapshot missing");
      // A playlist edited while paging is never published as a reusable snapshot.
      // Its conservatively collected exclusions still protect this generation.
      const statements: D1PreparedStatement[] = current.snapshot_id === entry.snapshot_id
        ? [env.DB.prepare(`INSERT INTO playlist_snapshots (context, spotify_id, snapshot_id, completed_at)
            SELECT ?, ?, ?, ? WHERE ${JOB_MUTATION_GUARD}
            ON CONFLICT(context, spotify_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, completed_at = excluded.completed_at`)
          .bind(entry.cache_context, entry.spotify_id, entry.snapshot_id, now(), ...jobMutationBindings(job))]
        : [env.DB.prepare(`DELETE FROM playlist_snapshot_pages WHERE context = ? AND spotify_id = ? AND snapshot_id = ? AND ${JOB_MUTATION_GUARD}`)
          .bind(entry.cache_context, entry.spotify_id, entry.snapshot_id, ...jobMutationBindings(job))];
      await env.DB.batch([...statements, ...remove()]);
      return finishUnit(env, job, token.reads);
    }
    const page = await spotifyPage<SpotifyPlaylistItem>(entry.cursor ?? playlistItemsUrl(entry.spotify_id, job.market), token, "playlist items", env);
    const mappings = knownTracks(page.items.map((item) => item?.item ?? item?.track));
    const statements = knownTrackStatements(env, job, mappings);
    if (entry.snapshot_id && entry.cache_context) {
      if (!entry.cursor) statements.push(
        env.DB.prepare(`DELETE FROM playlist_snapshots WHERE context = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
          .bind(entry.cache_context, entry.spotify_id, ...jobMutationBindings(job)),
        env.DB.prepare(`DELETE FROM playlist_snapshot_pages WHERE context = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
          .bind(entry.cache_context, entry.spotify_id, ...jobMutationBindings(job)),
      );
      statements.push(playlistPageStatement(env, job, entry.cache_context, entry.spotify_id, entry.snapshot_id, entry.cursor ?? playlistItemsUrl(entry.spotify_id, job.market), mappings));
    }
    const cacheable = Boolean(entry.snapshot_id && entry.cache_context);
    statements.push(progressStatement(env, job, { playlistTracksScanned: page.items.length }));
    const cursorMutation = page.next
      ? env.DB.prepare(`UPDATE rebuild_playlist_queue SET cursor = ? WHERE generation = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
        .bind(page.next, job.generation, entry.spotify_id, ...jobMutationBindings(job))
      : cacheable
        ? env.DB.prepare(`UPDATE rebuild_playlist_queue SET status = 'verify', cursor = NULL WHERE generation = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
          .bind(job.generation, entry.spotify_id, ...jobMutationBindings(job))
        : null;
    await env.DB.batch([...statements, ...(cursorMutation ? [cursorMutation] : remove())]);
  } catch (cause) {
    if (!expectedSkip(cause)) throw cause;
    const statements = [...remove(), warningIncrement(env, "playlistsUnavailable")];
    if (entry.cache_context) statements.push(env.DB.prepare(`DELETE FROM playlist_snapshots WHERE context = ? AND spotify_id = ? AND ${JOB_MUTATION_GUARD}`)
      .bind(entry.cache_context, entry.spotify_id, ...jobMutationBindings(job)));
    await env.DB.batch(statements);
    logSkip(job, "playlist", entry.spotify_id, cause.status);
  }
  return finishUnit(env, job, token.reads);
}

/**
 * Promotion gates. Zero staged candidates never promotes. Without a live shelf
 * any nonempty generation promotes. With a live shelf, keeping at least half of
 * it promotes (clearing any pending-low); a first nonempty miss below the floor
 * is quarantined (pending-low set); the next completed nonempty miss below the
 * floor promotes regardless of similarity. Failures never reach this code.
 */
async function promote(env: Env, job: RebuildJobRow): Promise<PromotionOutcome | null> {
  const state = await env.DB.prepare("SELECT live_generation, pending_low FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null; pending_low: number }>();
  const stagedCount = await eligibleCount(env, job.generation);
  let outcome: PromotionOutcome;
  let pendingLow = state?.pending_low ?? 0;
  if (stagedCount === 0) outcome = "empty";
  else if (!state?.live_generation) outcome = "promoted";
  else {
    const liveCount = await eligibleCount(env, state.live_generation, job.generation);
    const overlap = await overlapCount(env, state.live_generation, job.generation);
    const similar = liveCount > 0 && overlap / liveCount >= PROMOTION_SIMILARITY_FLOOR;
    if (liveCount === 0 || similar || pendingLow === 1) {
      outcome = "promoted";
      pendingLow = 0;
    } else {
      outcome = "quarantined";
      pendingLow = 1;
    }
  }
  const timestamp = now();
  const statements: D1PreparedStatement[] = [env.DB.prepare(`UPDATE rebuild_jobs SET progress_json = json_set(progress_json, '$.newRecordings', (
    SELECT count(*) FROM recordings r WHERE r.generation=? AND ${ELIGIBLE_FILTER}
      AND NOT EXISTS (SELECT 1 FROM recordings old WHERE old.generation=(SELECT base_generation FROM refresh_history WHERE generation=?)
        AND old.recording_key=r.recording_key AND NOT EXISTS (
          SELECT 1 FROM refresh_publications p WHERE p.generation=? AND p.live_generation=old.generation AND p.recording_key=old.recording_key))))
      WHERE singleton=1 AND ${JOB_MUTATION_GUARD}`)
    .bind(job.generation, job.generation, job.generation, ...jobMutationBindings(job))];
  if (outcome === "promoted" || state?.live_generation === job.generation) {
    // Materialize and publish in the same D1 transaction. An owner exclusion
    // committed before this batch is included in the rebuilt slots; one that
    // commits after it observes the generation as live and compacts it there.
    statements.push(...recommendationPoolStatements(env, job.generation, job));
  }
  let promotionUpdateIndex: number | null = null;
  if (outcome === "promoted") {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO recording_generations (generation, promoted_at)
       SELECT ?, ? WHERE ${JOB_MUTATION_GUARD} AND EXISTS (
         SELECT 1 FROM recommendation_slots WHERE generation = ? LIMIT 1
       )`,
    ).bind(job.generation, timestamp, ...jobMutationBindings(job), job.generation));
    promotionUpdateIndex = statements.length;
    statements.push(env.DB.prepare(
      `UPDATE refresh_state
       SET live_generation = ?, refreshed_at = ?,
           candidate_count = (SELECT COUNT(*) FROM recommendation_slots WHERE generation = ?),
           live_bucket_count = (SELECT COUNT(*) FROM recommendation_buckets WHERE generation = ?),
           pending_low = ?, last_outcome = ?, last_outcome_at = ?, last_error = NULL
       WHERE singleton = 1 AND ${JOB_MUTATION_GUARD} AND EXISTS (
         SELECT 1 FROM recommendation_slots WHERE generation = ? LIMIT 1
       )`,
    ).bind(job.generation, timestamp, job.generation, job.generation, pendingLow, outcome, timestamp, ...jobMutationBindings(job), job.generation));
    // The preliminary similarity decision can become empty if an owner action
    // excludes the last staged row concurrently. Keep the previous shelf and
    // record the authoritative final outcome instead of promoting zero slots.
    statements.push(env.DB.prepare(
      `UPDATE refresh_state
       SET candidate_count = CASE WHEN live_generation = ? THEN 0 ELSE candidate_count END,
           live_bucket_count = CASE WHEN live_generation = ? THEN 0 ELSE live_bucket_count END,
           last_outcome = 'empty', last_outcome_at = ?, last_error = NULL
       WHERE singleton = 1 AND ${JOB_MUTATION_GUARD} AND NOT EXISTS (
         SELECT 1 FROM recommendation_slots WHERE generation = ? LIMIT 1
       )`,
    ).bind(job.generation, job.generation, timestamp, ...jobMutationBindings(job), job.generation));
  } else if (state?.live_generation === job.generation) {
    // A bootstrap generation is already live while it finishes crawling. If
    // owner changes made it empty, publish the now-empty slot counts too.
    statements.push(env.DB.prepare(
      `UPDATE refresh_state
       SET candidate_count = (SELECT COUNT(*) FROM recommendation_slots WHERE generation = ?),
           live_bucket_count = (SELECT COUNT(*) FROM recommendation_buckets WHERE generation = ?),
           pending_low = ?, last_outcome = ?, last_outcome_at = ?, last_error = NULL
       WHERE singleton = 1 AND ${JOB_MUTATION_GUARD}`,
    ).bind(job.generation, job.generation, pendingLow, outcome, timestamp, ...jobMutationBindings(job)));
  } else {
    statements.push(env.DB.prepare(`UPDATE refresh_state SET pending_low = ?, last_outcome = ?, last_outcome_at = ?, last_error = NULL WHERE singleton = 1 AND ${JOB_MUTATION_GUARD}`).bind(pendingLow, outcome, timestamp, ...jobMutationBindings(job)));
  }
  statements.push(
    env.DB.prepare(`DELETE FROM rebuild_seed_artists WHERE generation = ? AND ${JOB_MUTATION_GUARD}`).bind(job.generation, ...jobMutationBindings(job)),
    env.DB.prepare(`DELETE FROM rebuild_album_queue WHERE generation = ? AND ${JOB_MUTATION_GUARD}`).bind(job.generation, ...jobMutationBindings(job)),
    env.DB.prepare(`DELETE FROM rebuild_enrich_queue WHERE generation = ? AND ${JOB_MUTATION_GUARD}`).bind(job.generation, ...jobMutationBindings(job)),
    env.DB.prepare(`DELETE FROM rebuild_playlist_queue WHERE generation = ? AND ${JOB_MUTATION_GUARD}`).bind(job.generation, ...jobMutationBindings(job)),
  );
  // The known overlay of a promoted generation survives as the live overlay.
  statements.push(env.DB.prepare(`UPDATE refresh_state SET
    last_progress_json = (SELECT progress_json FROM rebuild_jobs WHERE singleton = 1),
    last_request_counts_json = (SELECT request_counts_json FROM rebuild_jobs WHERE singleton = 1),
    last_progress_started_at = (SELECT progress_started_at FROM rebuild_jobs WHERE singleton = 1),
    last_progress_partial = (SELECT progress_partial FROM rebuild_jobs WHERE singleton = 1)
    WHERE singleton = 1 AND ${JOB_MUTATION_GUARD}`).bind(...jobMutationBindings(job)));
  statements.push(env.DB.prepare(`UPDATE refresh_history SET finished_at=?, outcome=?,
    progress_json=(SELECT progress_json FROM rebuild_jobs WHERE generation=?) WHERE generation=? AND ${JOB_MUTATION_GUARD}`)
    .bind(timestamp, outcome, job.generation, job.generation, ...jobMutationBindings(job)));
  const jobDeleteIndex = statements.length;
  statements.push(env.DB.prepare(
    "DELETE FROM rebuild_jobs WHERE singleton = 1 AND generation = ? AND revision = ? AND phase = ? AND status = 'active'",
  ).bind(job.generation, job.revision, job.phase));
  const results = await env.DB.batch(statements);
  // A migration or replacement job invalidated this delivery before its atomic
  // publication batch began. Let the consumer re-read and wake that current
  // job instead of acknowledging a false completion.
  if ((results[jobDeleteIndex]?.meta.changes ?? 0) === 0) return null;
  if (promotionUpdateIndex !== null && (results[promotionUpdateIndex]?.meta.changes ?? 0) === 0) outcome = "empty";
  console.log(JSON.stringify({ event: `rebuild_${outcome}`, generation: job.generation, staged: stagedCount }));
  return outcome;
}

async function failSystemically(env: Env, job: RebuildJobRow, message: string): Promise<AdvanceOutcome> {
  const results = await env.DB.batch([
    // Keep the global failure marker in the same guarded transaction as the
    // job transition. A migration-revision race must not fail the replacement
    // job or overwrite its public status with an error from stale work.
    env.DB.prepare(
      `UPDATE refresh_state
       SET last_error = ?, last_outcome = 'failed', last_outcome_at = ?
       WHERE singleton = 1 AND ${JOB_MUTATION_GUARD}`,
    ).bind(message, now(), ...jobMutationBindings(job)),
    // The failed job stays visible until the next scheduled tick replaces it;
    // pending-low is deliberately neither cleared nor confirmed.
    env.DB.prepare(
      "UPDATE rebuild_jobs SET status = 'failed', lease_until = NULL, retry_at = NULL, wait_reason = NULL, dispatch_pending = 0, updated_at = ? WHERE singleton = 1 AND generation = ? AND revision = ? AND phase = ? AND status = 'active'",
    ).bind(now(), job.generation, job.revision, job.phase),
  ]);
  if ((results[1]?.meta.changes ?? 0) === 0) return { kind: "scheduled", delaySeconds: 0 };
  await env.DB.prepare("UPDATE refresh_history SET finished_at=?,outcome='failed',error=?,progress_json=(SELECT progress_json FROM rebuild_jobs WHERE generation=?) WHERE generation=?")
    .bind(now(), safeReason(message, env), job.generation, job.generation).run();
  console.log(JSON.stringify({ event: "rebuild_failed_systemically", phase: job.phase, reason: message }));
  return { kind: "failed" };
}

async function handleFailure(env: Env, job: RebuildJobRow, cause: unknown): Promise<AdvanceOutcome> {
  const failure = cause instanceof RefreshFailure ? cause : new RefreshFailure(job.phase, 0, safeReason(cause instanceof Error ? cause.message : cause, env));
  const guard = "WHERE singleton = 1 AND generation = ? AND revision = ? AND phase = ? AND status = 'active'";
  if (failure.status === 429) {
    const fallback = failure.quotaExceeded
      ? Math.min(QUOTA_RETRY_MAX_SECONDS, QUOTA_RETRY_SECONDS * 2 ** Math.min(job.quota_attempts, 5))
      : Math.ceil(MIN_READ_GAP_SECONDS * Math.min(30, job.pace_multiplier * 2));
    const seconds = failure.quotaExceeded ? (failure.retryAfterSeconds ?? fallback) : Math.max(failure.retryAfterSeconds ?? 5, fallback);
    const retrySource = failure.retryAfterSeconds !== undefined && failure.retryAfterSeconds >= seconds ? "spotify" : "backoff";
    const waitReason = failure.quotaExceeded ? "quota" : "rate_limit";
    await env.DB.prepare(`UPDATE rebuild_jobs SET lease_until = NULL, retry_at = ?, wait_reason = ?, retry_source = ?,
      quota_endpoint = CASE WHEN ? THEN ? ELSE quota_endpoint END,
      quota_attempts = quota_attempts + ?, quota_wait_started_at = CASE WHEN ? THEN coalesce(quota_wait_started_at, ?) ELSE quota_wait_started_at END,
      pace_multiplier = ?, pace_successes = 0, revision = revision + 1, dispatch_pending = 1, updated_at = ? ${guard}`)
      .bind(now() + seconds * 1000, waitReason, retrySource, failure.quotaExceeded ? 1 : 0, failure.endpoint ?? null, failure.quotaExceeded ? 1 : 0, failure.quotaExceeded ? 1 : 0, now(),
        failure.quotaExceeded ? job.pace_multiplier : Math.min(30, job.pace_multiplier * 2), now(), job.generation, job.revision, job.phase).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO quota_interruptions(generation,revision,occurred_at,endpoint,reason,retry_at,retry_source)
      VALUES (?,?,?,?,?,?,?)`).bind(job.generation, job.revision, now(), failure.endpoint ?? null, waitReason, now() + seconds * 1000, retrySource).run();
    console.log(JSON.stringify({ event: failure.quotaExceeded ? "rebuild_quota_wait" : "rebuild_rate_limited", phase: job.phase, wait_seconds: seconds, retry_source: retrySource, quota_attempt: job.quota_attempts + 1 }));
    return { kind: "scheduled", delaySeconds: seconds };
  }

  const retryable = failure.status === 0 || failure.status >= 500;
  if (retryable) {
    const attempts = job.retry_count + 1;
    const longPause = attempts >= MAX_ATTEMPTS;
    const fallback = longPause ? UPSTREAM_RETRY_SECONDS
      : Math.min(RETRY_MAX_DELAY_SECONDS, RETRY_BASE_SECONDS * 2 ** (attempts - 1));
    const delaySeconds = Math.max(fallback, failure.retryAfterSeconds ?? 0);
    const source = failure.retryAfterSeconds !== undefined && failure.retryAfterSeconds >= fallback ? "spotify" : "backoff";
    await env.DB.prepare(`UPDATE rebuild_jobs SET lease_until = NULL, retry_at = ?, wait_reason = 'upstream', retry_source = ?, retry_count = ?, revision = revision + 1, dispatch_pending = 1, updated_at = ? ${guard}`).bind(now() + delaySeconds * 1000, source, longPause ? 0 : attempts, now(), job.generation, job.revision, job.phase).run();
    console.log(JSON.stringify({ event: longPause ? "rebuild_upstream_wait" : "rebuild_retry", phase: job.phase, attempt: attempts, status: failure.status, wait_seconds: delaySeconds }));
    return { kind: "scheduled", delaySeconds };
  }
  return failSystemically(env, job, `${failure.operation} failed (${failure.status}): ${safeReason(failure.reason, env)}`);
}

function leaseRetryDelaySeconds(leaseUntil: number | null | undefined, currentTime = now()): number {
  return leaseUntil && leaseUntil > currentTime
    ? Math.max(5, Math.ceil((leaseUntil - currentTime) / 1000) + 1)
    : 5;
}

async function advance(env: Env, job: RebuildJobRow): Promise<AdvanceOutcome> {
  if (!await acquireLease(env, job)) {
    // A duplicate delivery may have read the job before another consumer set
    // its lease. Re-read the deadline and retry after expiry: retrying every 5s
    // can exhaust Queue max_retries before a 120s crash lease becomes available.
    const current = await env.DB.prepare(
      "SELECT lease_until FROM rebuild_jobs WHERE singleton = 1 AND generation = ?",
    ).bind(job.generation).first<{ lease_until: number | null }>();
    const delaySeconds = leaseRetryDelaySeconds(current?.lease_until);
    return { kind: "busy", delaySeconds };
  }
  job.deadlineAt = now() + 90_000;
  try {
    switch (job.phase) {
      case "preflight": return await preflightUnit(env, job);
      case "never_identities": return await neverIdentitiesUnit(env, job);
      case "seeds": return await seedsUnit(env, job);
      case "artist_albums": return await artistAlbumsUnit(env, job);
      case "album_tracks": return await albumTracksUnit(env, job);
      case "enrich": return await enrichUnit(env, job);
      case "known_liked": return await knownLikedUnit(env, job);
      case "known_playlists": return await knownPlaylistsUnit(env, job);
      case "known_playlist_items": return await knownPlaylistItemsUnit(env, job);
      case "promote": {
        const outcome = await promote(env, job);
        return outcome === null ? { kind: "scheduled", delaySeconds: 0 } : { kind: "complete", outcome };
      }
    }
    throw new Error("Unknown refresh phase");
  } catch (cause) {
    return await handleFailure(env, job, cause);
  } finally {
    await saveRequestUsage(env, job.generation, job.usage ?? {});
  }
}

export async function startRebuild(env: Env): Promise<RefreshStatus> {
  const generation = `v4-${randomToken()}`;
  const timestamp = now();
  // Every cleanup/history change is conditional on winning the singleton
  // claim in this transaction. A stale caller cannot erase another job.
  const claimed = (sql: string, ...bindings: (string | number)[]) => env.DB.prepare(
    `${sql} AND EXISTS (SELECT 1 FROM rebuild_jobs claim WHERE claim.singleton = 1 AND claim.generation = ?)`,
  ).bind(...bindings, generation);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rebuild_jobs WHERE singleton = 1 AND status = 'failed'"),
    env.DB.prepare("INSERT OR IGNORE INTO rebuild_jobs (singleton, generation, status, phase, revision, next_read_at, dispatch_pending, started_at, updated_at, progress_started_at) VALUES (1, ?, 'active', 'preflight', 0, 0, 1, ?, ?, ?)").bind(generation, timestamp, timestamp, timestamp),
    claimed("DELETE FROM refresh_history WHERE generation NOT IN (SELECT generation FROM refresh_history ORDER BY started_at DESC LIMIT 29)"),
    claimed("DELETE FROM refresh_publications WHERE generation NOT IN (SELECT generation FROM refresh_history)"),
    claimed("DELETE FROM operational_activity WHERE hour < ?", timestamp - 30 * DAY_MS),
    claimed("DELETE FROM quota_interruptions WHERE occurred_at < ?", timestamp - 30 * DAY_MS),
    claimed("INSERT INTO refresh_history(generation,started_at,base_generation) SELECT ?,?,live_generation FROM refresh_state WHERE singleton=1", generation, timestamp),
    claimed("DELETE FROM spotify_track_cache WHERE expires_at <= ?", timestamp),
    claimed("DELETE FROM recording_identity_cache WHERE expires_at <= ?", timestamp),
    claimed("DELETE FROM track_availability WHERE expires_at <= ?", timestamp),
    claimed("DELETE FROM album_availability_pages WHERE expires_at <= ? AND NOT EXISTS (SELECT 1 FROM album_track_pages p WHERE p.context = album_availability_pages.context AND p.album_id = album_availability_pages.album_id AND p.cursor = album_availability_pages.cursor)", timestamp),
    claimed("DELETE FROM service_token_cache WHERE expires_at <= ?", timestamp),
    claimed("DELETE FROM album_track_pages WHERE expires_at <= ?", timestamp),
    claimed("DELETE FROM playlist_snapshots WHERE completed_at <= ?", timestamp - PLAYLIST_CACHE_TTL_MS),
    claimed(`DELETE FROM playlist_snapshot_pages WHERE NOT EXISTS (SELECT 1 FROM playlist_snapshots s
      WHERE s.context = playlist_snapshot_pages.context AND s.spotify_id = playlist_snapshot_pages.spotify_id
        AND s.snapshot_id = playlist_snapshot_pages.snapshot_id)`),
    claimed("DELETE FROM rebuild_known_tracks WHERE generation <> ? AND generation <> COALESCE((SELECT live_generation FROM refresh_state WHERE singleton = 1), '')", generation),
    // Abandoned staging generations go; every ever-promoted generation stays.
    claimed("DELETE FROM recommendation_slots WHERE generation NOT IN (SELECT generation FROM recording_generations)"),
    claimed("DELETE FROM recommendation_buckets WHERE generation NOT IN (SELECT generation FROM recording_generations)"),
    claimed("DELETE FROM recordings WHERE generation NOT IN (SELECT generation FROM recording_generations)"),
    claimed("DELETE FROM rebuild_seed_artists WHERE generation <> ?", generation),
    claimed("DELETE FROM rebuild_album_queue WHERE generation <> ?", generation),
    claimed("DELETE FROM rebuild_enrich_queue WHERE generation <> ?", generation),
    claimed("DELETE FROM rebuild_playlist_queue WHERE generation <> ?", generation),
    claimed("DELETE FROM rebuild_known_recordings WHERE generation <> ? AND generation <> COALESCE((SELECT live_generation FROM refresh_state WHERE singleton = 1), '')", generation),
    claimed("UPDATE refresh_state SET last_error = NULL, warnings_json = '{}' WHERE singleton = 1"),
  ]);
  const job = await currentJob(env);
  if (!job) throw new Error("rebuild job could not be created");
  if (job.generation === generation) await dispatch(env, job, 0);
  return statusSnapshot(env);
}

/** Reactivate only failures that the previous deployment classified as terminal. */
async function recoverLegacyTransientFailure(env: Env, job: RebuildJobRow): Promise<RebuildJobRow | null> {
  if (job.status !== "failed") return job;
  const state = await env.DB.prepare("SELECT last_error FROM refresh_state WHERE singleton = 1").first<{ last_error: string | null }>();
  const quotaFailure = state?.last_error?.includes("Spotify Development Mode quota exceeded");
  const upstreamFailure = /failed \((?:0|5\d{2})\): .*giving up after 5 attempts$/.test(state?.last_error ?? "");
  if (!quotaFailure && !upstreamFailure) return job;
  // A wake never erases staging or bypasses an unexpired retry deadline.
  const retryAt = Math.max(now(), job.updated_at + (quotaFailure ? QUOTA_RETRY_SECONDS : UPSTREAM_RETRY_SECONDS) * 1000);
  await env.DB.batch([
    env.DB.prepare(`UPDATE rebuild_jobs SET status = 'active', lease_until = NULL, retry_at = ?, wait_reason = ?, retry_source = 'backoff', retry_count = 0,
      revision = revision + 1, dispatch_pending = 1, updated_at = ?
      WHERE singleton = 1 AND generation = ? AND revision = ? AND status = 'failed'`)
      .bind(retryAt, quotaFailure ? "quota" : "upstream", now(), job.generation, job.revision),
    env.DB.prepare(`UPDATE refresh_state SET last_error = NULL WHERE singleton = 1
      AND EXISTS (SELECT 1 FROM rebuild_jobs WHERE generation = ? AND revision = ? AND status = 'active')`)
      .bind(job.generation, job.revision + 1),
  ]);
  return currentJob(env);
}

/** Resume legacy transient failures; start other idle/failed work or re-send an active wake. */
export async function startOrWakeRebuild(env: Env): Promise<RefreshStatus> {
  let job = await currentJob(env);
  if (job) job = await recoverLegacyTransientFailure(env, job);
  if (!job || job.status === "failed") return startRebuild(env);
  // An explicit wake can publish validated staging now. The consumer still
  // checks the original deadline before every path that can contact Spotify.
  const publishDuringWait = job.retry_at !== null && job.retry_at > now() && PUBLICATION_PHASES.includes(job.phase);
  await dispatch(env, job, publishDuringWait ? 0 : gateDelaySeconds(job));
  return statusSnapshot(env);
}

async function dispatch(env: Env, job: { generation: string; revision: number }, delaySeconds = 0): Promise<void> {
  const bounded = delaySeconds > 0 ? Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(1, Math.ceil(delaySeconds))) : 0;
  await env.REFRESH_QUEUE.send(
    { generation: job.generation, revision: job.revision },
    { contentType: "json", ...(bounded > 0 ? { delaySeconds: bounded } : {}) },
  );
  await env.DB.prepare("UPDATE rebuild_jobs SET dispatch_pending = 0 WHERE singleton = 1 AND generation = ? AND revision = ?").bind(job.generation, job.revision).run();
}

function gateDelaySeconds(job: Pick<RebuildJobRow, "retry_at" | "next_read_at">): number {
  const gate = Math.max(job.retry_at ?? 0, job.next_read_at ?? 0) - now();
  return gate > 0 ? Math.ceil(gate / 1000) : 0;
}

/** Make already validated staging useful during a provider wait. This path has
 * no Spotify/token calls and cannot advance a source cursor or clear a gate. */
async function publishWaitingBatch(env: Env, job: RebuildJobRow): Promise<boolean> {
  if (!PUBLICATION_PHASES.includes(job.phase)) return false;
  let afterArtist = '', afterKey = '';
  try {
    const progress = JSON.parse(job.progress_json) as Record<string, unknown>;
    if (typeof progress.publicationAfterArtist === 'string' && typeof progress.publicationAfterKey === 'string') {
      afterArtist = progress.publicationAfterArtist; afterKey = progress.publicationAfterKey;
    }
  } catch { /* Malformed progress starts a harmless idempotent publication pass. */ }
  const rows = await env.DB.prepare(`SELECT s.live_generation,r.bucket_artist_id,r.recording_key
    FROM refresh_state s JOIN recordings r ON r.generation=?
    WHERE s.singleton=1 AND s.live_generation IS NOT NULL AND s.live_generation<>r.generation
      AND r.bucket_artist_id>=? AND (r.bucket_artist_id>? OR r.recording_key>?)
      AND ${ELIGIBLE_FILTER}
      AND NOT EXISTS(SELECT 1 FROM recordings old WHERE old.generation=s.live_generation AND old.recording_key=r.recording_key)
      AND NOT EXISTS(SELECT 1 FROM recordings old WHERE old.generation=s.live_generation AND old.spotify_id=r.spotify_id)
      AND NOT EXISTS(SELECT 1 FROM rebuild_known_recordings k WHERE k.generation=s.live_generation AND k.recording_key=r.recording_key)
    ORDER BY r.bucket_artist_id,r.recording_key LIMIT ?`).bind(job.generation, afterArtist, afterArtist, afterKey, ENRICH_BATCH_LIMIT)
    .all<{ live_generation: string; bucket_artist_id: string; recording_key: string }>();
  const first = rows.results[0];
  if (!first || !await acquireLease(env, job)) return false;
  const keys = rows.results.filter(row => row.bucket_artist_id === first.bucket_artist_id).map(row => row.recording_key);
  try {
    await env.DB.batch([
      ...artistPublicationStatements(env, job, first.live_generation, first.bucket_artist_id, keys),
      env.DB.prepare(`UPDATE rebuild_jobs SET lease_until=NULL,
        progress_json=json_set(progress_json,'$.publicationAfterArtist',?,'$.publicationAfterKey',?)
        WHERE singleton=1 AND ${JOB_MUTATION_GUARD}`)
        .bind(first.bucket_artist_id, keys.at(-1)!, ...jobMutationBindings(job)),
    ]);
  } catch (error) {
    // Do not leave a lease behind after an ordinary rolled-back write error.
    await env.DB.prepare(`UPDATE rebuild_jobs SET lease_until=NULL WHERE singleton=1 AND ${JOB_MUTATION_GUARD}`)
      .bind(...jobMutationBindings(job)).run();
    throw error;
  }
  return true;
}

function validMessage(value: unknown): value is RefreshMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { generation?: unknown; revision?: unknown };
  return typeof message.generation === "string" && message.generation.length > 0 && Number.isInteger(message.revision) && (message.revision as number) >= 0;
}

export async function consumeRefreshQueue(batch: MessageBatch<RefreshMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    if (!validMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      let job = await currentJob(env);
      if (!job || job.generation !== message.body.generation) {
        message.ack();
        continue;
      }
      if (job.revision !== message.body.revision) {
        if (job.dispatch_pending === 1) await dispatch(env, job, gateDelaySeconds(job));
        message.ack();
        continue;
      }
      if (job.status === "failed") {
        job = await recoverLegacyTransientFailure(env, job);
        if (job?.status === "active" && job.generation === message.body.generation) await dispatch(env, job, gateDelaySeconds(job));
        message.ack();
        continue;
      }
      const gate = gateDelaySeconds(job);
      if (gate > 0) {
        const published = await publishWaitingBatch(env, job);
        // Defer via a fresh message so cooldowns and the read gap never burn a
        // delivery's own retry budget.
        await dispatch(env, job, published ? 0 : gate);
        message.ack();
        continue;
      }
      const outcome = await advance(env, job);
      if (outcome.kind === "busy") {
        message.retry({ delaySeconds: outcome.delaySeconds });
        continue;
      }
      if (outcome.kind === "scheduled") {
        job = await currentJob(env);
        if (job && job.generation === message.body.generation && job.dispatch_pending === 1) await dispatch(env, job, outcome.delaySeconds);
      }
      message.ack();
    } catch (cause) {
      console.error(JSON.stringify({ event: "rebuild_queue_failed", reason: safeReason(cause instanceof Error ? cause.message : cause, env) }));
      message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(message.attempts, 5)) });
    }
  }
}

function renderWarnings(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let counts: WarningCounts = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") counts = parsed as WarningCounts;
  } catch {
    return [];
  }
  return WARNING_LABELS.filter(([field]) => typeof counts[field] === "number" && counts[field]! > 0).map(([field, label]) => `${counts[field]} ${label}`);
}

export async function statusSnapshot(env: Env): Promise<RefreshStatus> {
  const [job, state] = await Promise.all([
    currentJob(env),
    env.DB.prepare("SELECT live_generation, refreshed_at, last_publication_at, candidate_count, last_error, pending_low, last_outcome, last_outcome_at, next_refresh_at, warnings_json, last_progress_json, last_request_counts_json, last_progress_started_at, last_progress_partial FROM refresh_state WHERE singleton = 1").first<StateRow>(),
  ]);
  const liveGeneration = state?.live_generation ?? null;
  const candidateCount = liveGeneration ? state?.candidate_count ?? 0 : 0;
  // Poll two singleton rows, never recount growing catalogue/work tables.
  const progress = numericProgress(job ? job.progress_json : state?.last_progress_json);
  const requests = requestUsage(job ? job.request_counts_json : state?.last_request_counts_json);
  const retrySeconds = job?.retry_at && job.retry_at > now() ? Math.max(1, Math.ceil((job.retry_at - now()) / 1000)) : undefined;
  const jobState = !job ? "idle" : job.status === "failed" ? "failed" : retrySeconds ? "waiting" : "active";
  return {
    state: jobState,
    refreshId: job?.generation ?? null,
    phase: job?.phase ?? null,
    phaseLabel: job ? PHASE_LABELS[job.phase] : null,
    progress,
    requests,
    requestCountBasis: "observed",
    progressPartial: Boolean(job ? job.progress_partial : state?.last_progress_partial),
    progressSinceAt: (job ? job.progress_started_at : state?.last_progress_started_at) ?? null,
    ...(job?.quota_last_recovery_at ? { quotaRecoveryAt: job.quota_last_recovery_at, quotaObservedWaitMs: job.quota_last_wait_ms ?? undefined } : {}),
    latestOutcome: state?.last_outcome ?? null,
    latestOutcomeAt: state?.last_outcome_at ?? null,
    candidateCount,
    refreshedAt: state?.refreshed_at ?? null,
    lastPublicationAt: state?.last_publication_at ?? null,
    warnings: renderWarnings(state?.warnings_json),
    nextRefreshAt: state?.next_refresh_at ?? null,
    ...(state?.last_error ? { error: state.last_error } : {}),
    ...(jobState === "waiting" && retrySeconds ? { retryAfterSeconds: retrySeconds, retryAt: job!.retry_at!, waitReason: job!.wait_reason ?? "rate_limit", retrySource: job!.retry_source ?? "backoff" } : {}),
  };
}

/** Next fire time of the weekly Sunday rebuild cron, in UTC. */
export function nextWeeklyCronAt(from: number): number {
  const [minute, hour] = CRON_EXPRESSION.split(" ").map(Number);
  const date = new Date(from);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, 0);
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = today + offset * DAY_MS;
    if (candidate > from && new Date(candidate).getUTCDay() === 0) return candidate;
  }
  return today + 7 * DAY_MS;
}

/**
 * Route maintenance and weekly triggers separately. Only the weekly trigger
 * starts idle/failed work; the watchdog resumes overdue active work after a
 * two-minute grace beyond every lease, pacing and retry gate.
 */
export async function scheduledTick(env: Env, scheduledTime: number, cron = CRON_EXPRESSION): Promise<void> {
  if (cron === WATCHDOG_CRON_EXPRESSION) {
    // Maintenance is bounded even if a quota-blocked refresh lasts for months.
    const scheduled = new Date(scheduledTime);
    if (scheduled.getUTCHours() === 0 && scheduled.getUTCMinutes() === 0) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM operational_activity WHERE hour < ?").bind(now() - 30 * DAY_MS),
        env.DB.prepare(`DELETE FROM quota_interruptions WHERE occurred_at < ? OR rowid NOT IN (
          SELECT rowid FROM quota_interruptions ORDER BY occurred_at DESC LIMIT 2000)`).bind(now() - 30 * DAY_MS),
      ]);
    }
    const job = await currentJob(env);
    // Only recover overdue active work. In particular, an idle/failed job must
    // not turn this frequent maintenance tick into a new catalogue refresh.
    if (!job || job.status !== "active") return;
    const overdueAt = Math.max(job.updated_at, job.lease_until ?? 0, job.retry_at ?? 0, job.next_read_at) + REFRESH_LEASE_MS;
    if (now() < overdueAt) return;
    await dispatch(env, job);
    console.log(JSON.stringify({ event: "rebuild_watchdog_wake", phase: job.phase, revision: job.revision }));
    return;
  }
  if (cron !== CRON_EXPRESSION) return;
  await env.DB.prepare("UPDATE refresh_state SET next_refresh_at = ? WHERE singleton = 1").bind(nextWeeklyCronAt(scheduledTime)).run();
  await startOrWakeRebuild(env);
}
