import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initialMigration from "../migrations/0001_initial.sql?raw";
import stagingMigration from "../migrations/0002_refresh_staging.sql?raw";
import incrementalMigration from "../migrations/0003_incremental_refresh.sql?raw";
import leaseMigration from "../migrations/0004_refresh_lease.sql?raw";
import playlistSkipMigration from "../migrations/0005_refresh_playlist_skip_reason.sql?raw";
import refreshAlgorithmMigration from "../migrations/0006_refresh_algorithm.sql?raw";
import backgroundRefreshMigration from "../migrations/0007_background_refresh.sql?raw";
import spotifyWaitReasonMigration from "../migrations/0008_spotify_wait_reason.sql?raw";
import v4Migration from "../migrations/0009_v4_recordings.sql?raw";
import identityAndSlotsMigration from "../migrations/0010_account_identity_and_recommendation_slots.sql?raw";
import atomicPoolMigration from "../migrations/0011_atomic_recommendation_pool_mutations.sql?raw";
import legacyNeverIdentityMigration from "../migrations/0012_legacy_never_identity.sql?raw";
import neverIdentityChecksMigration from "../migrations/0013_never_identity_checks.sql?raw";
import restartReroutedRebuildMigration from "../migrations/0014_restart_rerouted_rebuild.sql?raw";
import preservePreflightGateMigration from "../migrations/0015_preserve_preflight_gate.sql?raw";
import resumableQuotaMigration from "../migrations/0016_resumable_quota_and_track_cache.sql?raw";
import incrementalDiscoveryMigration from "../migrations/0017_incremental_discovery.sql?raw";
import refreshProgressMigration from "../migrations/0018_refresh_progress.sql?raw";
import identityAvailabilityMigration from "../migrations/0019_identity_availability_and_artist_turns.sql?raw";
import operationalHistoryMigration from "../migrations/0020_operational_history.sql?raw";
import progressivePublicationMigration from "../migrations/0021_progressive_artist_publication.sql?raw";
import oauthProtectionMigration from "../migrations/0022_oauth_browser_binding_and_budgets.sql?raw";
import neverIsrcMigration from "../migrations/0023_never_isrc_lookup.sql?raw";
import worker from "../src/worker";
import { startRebuild, scheduledTick, startOrWakeRebuild, nextWeeklyCronAt, statusSnapshot, WATCHDOG_CRON_EXPRESSION, rebuildRecommendationPool, type RefreshMessage, type RefreshPhase } from "../src/rebuild";
import { statements } from "./statements";
import { catalogueContext, knownTrackStatements, knownIdentityStatements } from "../src/catalogue-cache";
import { readServiceToken, writeServiceToken } from "../src/service-token-cache";
import { readTrackCache, writeTrackCache } from "../src/track-cache";

const LIKED_URL = "https://api.spotify.com/v1/me/tracks?limit=50";
const PLAYLISTS_URL = "https://api.spotify.com/v1/me/playlists?limit=50";
const SERVICE_SCOPES = "user-library-read user-library-modify playlist-read-private playlist-read-collaborative user-read-private";
const artistId = "zyxwvutsrqponmlkjihgfe";
const otherArtistId = "aaaaaaaaaaaaaaaaaaaaa";
const trackId = "1234567890123456789012";
const albumId = "1111111111111111111111";
const playlistId = "2222222222222222222222";
const ownerUserId = "owner-user-id";

function queueEnv() {
  const send = vi.fn().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  const queue = {
    send,
    metrics: vi.fn().mockResolvedValue({ backlogCount: 0, backlogBytes: 0 }),
    sendBatch: vi.fn().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
  } satisfies Queue;
  return { testEnv: { ...env, REFRESH_QUEUE: queue } as Env, send };
}

/** Inject a migration-style job revision change immediately before one D1 batch. */
function raceBeforeBatch(testEnv: Env, targetBatch: number, beforeBatch: () => Promise<void>): Env {
  let batchNumber = 0;
  const database = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batchNumber += 1;
          if (batchNumber === targetBatch) await beforeBatch();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...testEnv, DB: database };
}

type JobSeed = {
  fairScheduler?: number;
  market?: string | null;
  ownerUserId?: string | null;
  cursor?: string | null;
  workKey?: string | null;
  revision?: number;
  retryAt?: number | null;
  retryCount?: number;
  nextReadAt?: number;
  dispatchPending?: number;
  status?: "active" | "failed";
};

async function seedJob(generation: string, phase: RefreshPhase, extras: JobSeed = {}) {
  await env.DB.prepare(
    "INSERT INTO rebuild_jobs (singleton, generation, status, phase, market, owner_user_id, cursor, work_key, revision, retry_at, retry_count, next_read_at, dispatch_pending, fair_scheduler, started_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)",
  ).bind(
    generation,
    extras.status ?? "active",
    phase,
    extras.market ?? null,
    extras.ownerUserId === undefined ? ownerUserId : extras.ownerUserId,
    extras.cursor ?? null,
    extras.workKey ?? null,
    extras.revision ?? 0,
    extras.retryAt ?? null,
    extras.retryCount ?? 0,
    extras.nextReadAt ?? 0,
    extras.dispatchPending ?? 0,
    extras.fairScheduler ?? 0,
  ).run();
}

async function jobRow(generation: string) {
  return env.DB.prepare("SELECT generation, status, phase, market, owner_user_id, cursor, work_key, revision, lease_until, retry_at, retry_count, next_read_at, dispatch_pending FROM rebuild_jobs WHERE generation = ?").bind(generation).first<{
    generation: string;
    status: string;
    phase: string;
    market: string | null;
    owner_user_id: string | null;
    cursor: string | null;
    work_key: string | null;
    revision: number;
    lease_until: number | null;
    retry_at: number | null;
    retry_count: number;
    next_read_at: number;
    dispatch_pending: number;
  }>();
}

async function stageRecording(generation: string, recordingKey: string, spotifyId: string, bucketArtistId = artistId) {
  await env.DB.prepare(
    "INSERT INTO recordings (generation, recording_key, spotify_id, isrc, title, album_name, release_date, image_url, spotify_url, artists_json, bucket_artist_id) VALUES (?, ?, ?, NULL, ?, 'Album', '2020-01-01', ?, ?, ?, ?)",
  ).bind(generation, recordingKey, spotifyId, `Track ${recordingKey}`, `https://i.scdn.co/${spotifyId}`, `https://open.spotify.com/track/${spotifyId}`, JSON.stringify([{ id: bucketArtistId, name: "Artist" }]), bucketArtistId).run();
}

async function setLive(generation: string | null) {
  await env.DB.prepare("UPDATE refresh_state SET live_generation = ? WHERE singleton = 1").bind(generation).run();
}

/**
 * Simulate wall-clock time passing: the retry cooldown and the 30-second read
 * gap are durable state in rebuild_jobs, so clearing them lets the very next
 * delivery run the unit instead of deferring it.
 */
async function elapsePacing(generation: string) {
  await env.DB.prepare("UPDATE rebuild_jobs SET retry_at = NULL, next_read_at = 0 WHERE generation = ?").bind(generation).run();
}

async function rerouteForMigration(generation: string) {
  await env.DB.prepare(
    "UPDATE rebuild_jobs SET phase = 'never_identities', cursor = NULL, work_key = NULL, lease_until = NULL, revision = revision + 1, dispatch_pending = 1 WHERE generation = ?",
  ).bind(generation).run();
}

async function deliver(message: RefreshMessage, testEnv: Env, attempts = 1) {
  const batch = createMessageBatch<RefreshMessage>("ferto-refresh", [{ id: crypto.randomUUID(), timestamp: new Date(), attempts, body: message }]);
  const ctx = createExecutionContext();
  if (!worker.queue) throw new Error("queue handler missing");
  await worker.queue(batch, testEnv);
  return getQueueResult(batch, ctx);
}

async function tick(testEnv: Env, scheduledTime = Date.now(), cron = "0 3 * * SUN") {
  const controller = createScheduledController({ cron, scheduledTime });
  const ctx = createExecutionContext();
  if (!worker.scheduled) throw new Error("scheduled handler missing");
  await worker.scheduled(controller, testEnv, ctx);
  // The scheduled handler defers all work into ctx.waitUntil, so the test must
  // settle it before asserting — otherwise the rebuild races the next test.
  await waitOnExecutionContext(ctx);
}

const tokenResponse = (scope = SERVICE_SCOPES, expiresIn = 0) => new Response(JSON.stringify({ access_token: "access", expires_in: expiresIn, scope }), { headers: { "Content-Type": "application/json" } });
const pageResponse = (items: unknown[], next: string | null = null, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(status === 200 ? { items, next } : { error: { message: `upstream failure ${status}` } }), { status, headers: { "Content-Type": "application/json", ...headers } });
const meResponse = (accountId: string, country?: string, userId = ownerUserId) => new Response(JSON.stringify({ id: userId, account_id: accountId, ...(country ? { country } : {}) }), { headers: { "Content-Type": "application/json" } });
const trackId22 = (index: number) => String(index).padStart(22, "0");
const quotaResponse = (retryAfter?: number) => new Response(JSON.stringify({ error: { status: 429, message: "quota", reason: "QUOTA_EXCEEDED" } }), {
  status: 429, headers: { "Content-Type": "application/json", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) },
});
const fullTrack = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  uri: `spotify:track:${id}`,
  name: `Song ${id}`,
  is_playable: true,
  artists: [{ id: artistId, name: "Artist" }],
  album: { name: "Album", release_date: "2020-01-01", images: [{ url: `https://i.scdn.co/${id}` }] },
  external_ids: { isrc: "USABC2100001" },
  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  ...overrides,
});

describe("v4 rebuild state machine", () => {
  beforeAll(async () => {
    const sql = [initialMigration, stagingMigration, incrementalMigration, leaseMigration, playlistSkipMigration, refreshAlgorithmMigration, backgroundRefreshMigration, spotifyWaitReasonMigration, v4Migration, identityAndSlotsMigration, atomicPoolMigration, legacyNeverIdentityMigration, neverIdentityChecksMigration, restartReroutedRebuildMigration, preservePreflightGateMigration, resumableQuotaMigration, incrementalDiscoveryMigration, refreshProgressMigration, identityAvailabilityMigration, operationalHistoryMigration, progressivePublicationMigration, oauthProtectionMigration, neverIsrcMigration].join("\n");
    for (const statement of statements(sql)) await env.DB.prepare(statement).run();
  });
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM recording_identity_cache"),
      env.DB.prepare("DELETE FROM track_availability"),
      env.DB.prepare("DELETE FROM album_availability_pages"),
      env.DB.prepare("DELETE FROM refresh_history"),
      env.DB.prepare("DELETE FROM refresh_publications"),
      env.DB.prepare("DELETE FROM operational_activity"),
      env.DB.prepare("DELETE FROM quota_interruptions"),
      env.DB.prepare("DELETE FROM service_token_cache"),
      env.DB.prepare("DELETE FROM rebuild_known_tracks"),
      env.DB.prepare("DELETE FROM playlist_snapshots"),
      env.DB.prepare("DELETE FROM playlist_snapshot_pages"),
      env.DB.prepare("DELETE FROM album_track_pages"),
      env.DB.prepare("DELETE FROM spotify_track_cache"),
      env.DB.prepare("DELETE FROM recordings"),
      env.DB.prepare("DELETE FROM recording_generations"),
      env.DB.prepare("DELETE FROM recommendation_slots"),
      env.DB.prepare("DELETE FROM recommendation_buckets"),
      env.DB.prepare("DELETE FROM never_recordings"),
      env.DB.prepare("DELETE FROM never_identity_checks"),
      env.DB.prepare("DELETE FROM rebuild_seed_artists"),
      env.DB.prepare("DELETE FROM rebuild_album_queue"),
      env.DB.prepare("DELETE FROM rebuild_enrich_queue"),
      env.DB.prepare("DELETE FROM rebuild_playlist_queue"),
      env.DB.prepare("DELETE FROM rebuild_known_recordings"),
      env.DB.prepare("DELETE FROM rebuild_jobs"),
      env.DB.prepare("UPDATE refresh_state SET live_generation = NULL, refreshed_at = NULL, last_publication_at = NULL, candidate_count = 0, live_bucket_count = 0, last_error = NULL, pending_low = 0, last_outcome = NULL, last_outcome_at = NULL, next_refresh_at = NULL, warnings_json = '{}', last_progress_json = '{}', last_request_counts_json = '{}', last_progress_started_at = NULL, last_progress_partial = 0 WHERE singleton = 1"),
    ]);
  });

  describe("atomic rebuild starts", () => {
    it("gives simultaneous owner and cron starts one durable generation and history entry", async () => {
      const { testEnv, send } = queueEnv();
      await Promise.all([startOrWakeRebuild(testEnv), scheduledTick(testEnv, Date.now())]);
      const job = await env.DB.prepare("SELECT generation FROM rebuild_jobs").first<{ generation: string }>();
      expect(job).not.toBeNull();
      const history = await env.DB.prepare("SELECT generation,outcome FROM refresh_history").all();
      expect(history.results).toEqual([{ generation: job!.generation, outcome: "active" }]);
      expect(send).toHaveBeenCalled();
      for (const [message] of send.mock.calls) expect(message.generation).toBe(job!.generation);
    });

    it("does not erase the winner's staging when an idle caller reaches its batch late", async () => {
      const { testEnv } = queueEnv();
      let winner = "";
      const racedEnv = raceBeforeBatch(testEnv, 1, async () => {
        winner = (await startRebuild(testEnv)).refreshId!;
        await stageRecording(winner, "isrc:USABC2100001", trackId);
      });
      const status = await startOrWakeRebuild(racedEnv);
      expect(status.refreshId).toBe(winner);
      expect(await env.DB.prepare("SELECT count(*) AS n FROM recordings WHERE generation = ?").bind(winner).first()).toEqual({ n: 1 });
      expect(await env.DB.prepare("SELECT generation FROM refresh_history WHERE outcome = 'active'").all()).toMatchObject({ results: [{ generation: winner }] });
    });

    it("replaces a failed job once across simultaneous restart requests", async () => {
      await seedJob("failed-start-race", "preflight");
      await env.DB.prepare("UPDATE rebuild_jobs SET status = 'failed'").run();
      const { testEnv } = queueEnv();
      const results = await Promise.all([startOrWakeRebuild(testEnv), startOrWakeRebuild(testEnv)]);
      expect(results[0].refreshId).toBe(results[1].refreshId);
      expect(results[0].refreshId).not.toBe("failed-start-race");
      expect(await env.DB.prepare("SELECT count(*) AS n FROM refresh_history WHERE outcome = 'active'").first()).toEqual({ n: 1 });
    });
  });

  describe("service-token preflight", () => {
    it("stops new network requests within the unit's lease and schedules recovery", async () => {
      const generation = "unit-network-budget";
      await seedJob(generation, "preflight");
      const { testEnv } = queueEnv();
      let timestamp = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => timestamp);
      const fetchSpy = vi.fn().mockImplementationOnce(async () => { timestamp += 90_001; return tokenResponse(); });
      vi.stubGlobal("fetch", fetchSpy);
      try {
        await deliver({ generation, revision: 0 }, testEnv);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(await jobRow(generation)).toMatchObject({ status: "active", phase: "preflight", lease_until: null });
        expect(await env.DB.prepare("SELECT wait_reason FROM rebuild_jobs").first()).toEqual({ wait_reason: "upstream" });
      } finally { clock.mockRestore(); }
    });

    it("validates scopes, account, and market, then paces the first data read", async () => {
      const generation = "preflight-ok";
      await seedJob(generation, "preflight");
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(meResponse(env.OWNER_SPOTIFY_ID, "GR"));
      vi.stubGlobal("fetch", fetchSpy);
      const startedAt = Date.now();
      const result = await deliver({ generation, revision: 0 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      expect(fetchSpy.mock.calls[1][0]).toBe("https://api.spotify.com/v1/me");
      const job = await jobRow(generation);
      expect(job).toMatchObject({ status: "active", phase: "never_identities", market: "GR", owner_user_id: ownerUserId, cursor: null, retry_count: 0 });
      expect(job!.next_read_at).toBeGreaterThanOrEqual(startedAt + 2_000);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 2 });
    });

    it("accepts a Development Mode profile without country and uses no explicit market", async () => {
      const generation = "preflight-no-country";
      await seedJob(generation, "preflight");
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(meResponse(env.OWNER_SPOTIFY_ID)));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "never_identities", market: null });
    });

    it("refreshes its PKCE service token with client_id in the form and no Basic auth", async () => {
      const generation = "preflight-pkce";
      await seedJob(generation, "preflight");
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(meResponse(env.OWNER_SPOTIFY_ID));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const form = new URLSearchParams(String(init.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe(testEnv.SPOTIFY_REFRESH_TOKEN);
      expect(form.get("client_id")).toBe(testEnv.SPOTIFY_CLIENT_ID);
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
    });

    it("fails systemically when a required scope is missing", async () => {
      const generation = "preflight-scopes";
      await seedJob(generation, "preflight");
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse("user-library-read user-read-private")));
      const result = await deliver({ generation, revision: 0 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      expect(await jobRow(generation)).toMatchObject({ status: "failed", phase: "preflight" });
      const state = await env.DB.prepare("SELECT last_error, last_outcome FROM refresh_state WHERE singleton = 1").first<{ last_error: string | null; last_outcome: string | null }>();
      expect(state?.last_outcome).toBe("failed");
      expect(state?.last_error).toContain("missing Spotify scopes");
      expect(state?.last_error).toContain("user-library-modify");
      expect(send).not.toHaveBeenCalled();
    });

    it("fails systemically when the token belongs to another account", async () => {
      const generation = "preflight-account";
      await seedJob(generation, "preflight");
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(meResponse("someone-else")));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ status: "failed" });
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("legacy Never identity resolution", () => {
    it("advances immediately when no exact-id exclusions need checking", async () => {
      const generation = "never-identities-empty";
      await seedJob(generation, "never_identities", { market: "GR" });
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await deliver({ generation, revision: 0 }, testEnv);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await jobRow(generation)).toMatchObject({ phase: "seeds", cursor: LIKED_URL, revision: 1 });
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json" });
    });

    it("resolves a requested legacy Never id when Dev Mode returns a different id without linked_from", async () => {
      const generation = "never-identities-relinked";
      const legacyId = trackId22(41);
      const returnedId = trackId22(42);
      await seedJob(generation, "never_identities", { market: "GR" });
      await env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, NULL, ?, 1)").bind(`spotify:${legacyId}`, legacyId).run();
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(returnedId)), { headers: { "Content-Type": "application/json" } })));

      await deliver({ generation, revision: 0 }, testEnv);

      expect(await env.DB.prepare("SELECT isrc FROM never_recordings WHERE spotify_id = ?").bind(legacyId).first()).toEqual({ isrc: "USABC2100001" });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM never_identity_checks WHERE spotify_id = ?").bind(legacyId).first<{ count: number }>()).toEqual({ count: 1 });
      expect(await jobRow(generation)).toMatchObject({ phase: "never_identities", cursor: null, revision: 1 });
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 2 });
    });

    it("marks a vanished exact id checked without blocking the rebuild", async () => {
      const generation = "never-identities-gone";
      const goneId = trackId22(43);
      await seedJob(generation, "never_identities", { market: "GR" });
      await env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, NULL, ?, 1)").bind(`spotify:${goneId}`, goneId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 404)));

      await deliver({ generation, revision: 0 }, testEnv);

      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM never_identity_checks WHERE spotify_id = ?").bind(goneId).first<{ count: number }>()).toEqual({ count: 1 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM never_recordings WHERE recording_key LIKE 'isrc:%'").first<{ count: number }>()).toEqual({ count: 0 });
      expect(await jobRow(generation)).toMatchObject({ status: "active", phase: "never_identities", revision: 1 });

      const check = await env.DB.prepare("SELECT checked_at FROM never_identity_checks WHERE spotify_id = ?").bind(goneId).first<{ checked_at: number }>();
      await env.DB.prepare("DELETE FROM rebuild_jobs").run();
      const nextGeneration = "never-identities-returned";
      await seedJob(nextGeneration, "never_identities", { market: "GR" });
      await env.DB.prepare("UPDATE rebuild_jobs SET started_at = ?, updated_at = ? WHERE singleton = 1").bind(check!.checked_at + 1, check!.checked_at + 1).run();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId22(44))), { headers: { "Content-Type": "application/json" } })));

      await deliver({ generation: nextGeneration, revision: 0 }, testEnv);

      expect(await env.DB.prepare("SELECT isrc FROM never_recordings WHERE spotify_id = ?").bind(goneId).first()).toEqual({ isrc: "USABC2100001" });
    });

    it("retries a malformed successful identity response without marking it checked", async () => {
      const generation = "never-identities-malformed";
      const legacyId = trackId22(45);
      await seedJob(generation, "never_identities", { market: "GR" });
      await env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, NULL, ?, 1)").bind(`spotify:${legacyId}`, legacyId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify({ external_ids: { isrc: "USABC2100001" } }), { headers: { "Content-Type": "application/json" } })));

      await deliver({ generation, revision: 0 }, testEnv);

      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM never_identity_checks WHERE spotify_id = ?").bind(legacyId).first<{ count: number }>()).toEqual({ count: 0 });
      expect(await jobRow(generation)).toMatchObject({ phase: "never_identities", retry_count: 1, revision: 1 });
    });
  });

  describe("seed freezing", () => {
    it("freezes first-credit seeds and liked recording identities before discovery", async () => {
      const generation = "seeds-freeze";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv } = queueEnv();
      const secondary = "bbbbbbbbbbbbbbbbbbbbbb";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { track: { id: trackId, artists: [{ id: artistId, name: "Primary" }, { id: secondary, name: "Secondary" }] } },
        { track: { id: trackId22(3), artists: [{ id: otherArtistId, name: "Other primary" }, { id: artistId, name: "Late credit" }] } },
        { track: null },
      ])));
      const result = await deliver({ generation, revision: 0 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      const seeds = await env.DB.prepare("SELECT spotify_id FROM rebuild_seed_artists WHERE generation = ? ORDER BY spotify_id").bind(generation).all<{ spotify_id: string }>();
      expect(seeds.results.map((row) => row.spotify_id)).toEqual([otherArtistId, artistId].sort());
      const known = await env.DB.prepare("SELECT recording_key FROM rebuild_known_recordings WHERE generation = ? ORDER BY recording_key").bind(generation).all<{ recording_key: string }>();
      expect(known.results).toEqual([{ recording_key: `spotify:${trackId22(3)}` }, { recording_key: `spotify:${trackId}` }]);
      expect(await jobRow(generation)).toMatchObject({ phase: "known_playlists", cursor: PLAYLISTS_URL });
    });

    it("freezes a full 50-track page through bounded multi-row D1 writes", async () => {
      const generation = "seeds-full-page";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv } = queueEnv();
      const items = Array.from({ length: 50 }, (_, index) => ({
        track: {
          id: trackId22(index + 1),
          artists: [{ id: `artist${String(index).padStart(16, "0")}`, name: `Artist ${index}` }],
        },
      }));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse(items)));
      await deliver({ generation, revision: 0 }, testEnv);
      const seedCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_seed_artists WHERE generation = ?").bind(generation).first<{ count: number }>();
      const knownCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_known_recordings WHERE generation = ?").bind(generation).first<{ count: number }>();
      expect(seedCount?.count).toBe(50);
      expect(knownCount?.count).toBe(50);
    });
  });

  describe("artist release crawl", () => {
    it("crawls album,single pages at limit 10 and queues them for the bucket artist", async () => {
      const generation = "crawl-albums";
      await seedJob(generation, "artist_albums", { market: "GR" });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id) VALUES (?, ?)").bind(generation, artistId).run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ id: albumId, name: "Album", images: [] }]));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(String(fetchSpy.mock.calls[1][0])).toBe(`https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&limit=10`);
      const queued = await env.DB.prepare("SELECT spotify_id, bucket_artist_id, album_name, status FROM rebuild_album_queue WHERE generation = ?").bind(generation).all<{ spotify_id: string; bucket_artist_id: string; album_name: string; status: string }>();
      // The release is queued as pending work for the album-tracks phase.
      expect(queued.results).toEqual([{ spotify_id: albumId, bucket_artist_id: artistId, album_name: "Album", status: "pending" }]);
      expect(await jobRow(generation)).toMatchObject({ phase: "album_tracks", work_key: artistId });
      expect(await env.DB.prepare("SELECT status FROM rebuild_seed_artists WHERE generation = ? AND spotify_id = ?").bind(generation, artistId).first<{ status: string }>()).toEqual({ status: "catalogued" });
    });

    it("skips a vanished artist with an aggregated warning and sanitized log", async () => {
      const generation = "crawl-skip";
      await seedJob(generation, "artist_albums", { market: "GR" });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id) VALUES (?, ?)").bind(generation, artistId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 404)));
      const result = await deliver({ generation, revision: 0 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      expect(await env.DB.prepare("SELECT status, skip_reason FROM rebuild_seed_artists WHERE generation = ?").bind(generation).first()).toEqual({ status: "catalogued", skip_reason: "not_found" });
      expect(await jobRow(generation)).toMatchObject({ phase: "album_tracks", work_key: artistId });
      const warnings = await env.DB.prepare("SELECT warnings_json FROM refresh_state WHERE singleton = 1").first<{ warnings_json: string }>();
      expect(JSON.parse(warnings!.warnings_json)).toEqual({ artistsUnavailable: 1 });
      expect(await (await statusSnapshot(env)).warnings).toEqual(["1 artists unavailable"]);

      await elapsePacing(generation);
      await deliver({ generation, revision: 1 }, testEnv);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_seed_artists WHERE generation = ?").bind(generation).first()).toEqual({ count: 0 });
      expect(await jobRow(generation)).toMatchObject({ phase: "artist_albums", work_key: null });
    });

    it("drains releases from successful pages when a later artist page vanishes", async () => {
      const generation = "crawl-partial-skip";
      const next = `https://api.spotify.com/v1/artists/${artistId}/albums?offset=10`;
      await seedJob(generation, "artist_albums", { market: "GR" });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id) VALUES (?, ?)").bind(generation, artistId).run();
      const { testEnv } = queueEnv();

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ id: albumId, name: "Partial album", images: [] }], next)));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await env.DB.prepare("SELECT spotify_id FROM rebuild_album_queue WHERE generation = ?").bind(generation).first()).toEqual({ spotify_id: albumId });

      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 404)));
      await deliver({ generation, revision: 1 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "album_tracks", work_key: artistId });
      expect(await env.DB.prepare("SELECT spotify_id FROM rebuild_album_queue WHERE generation = ? AND bucket_artist_id = ?").bind(generation, artistId).first()).toEqual({ spotify_id: albumId });

      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([])));
      await deliver({ generation, revision: 2 }, testEnv);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_album_queue WHERE generation = ?").bind(generation).first()).toEqual({ count: 0 });
    });

    it("recovers a stale work key after a skipped artist row was deleted", async () => {
      const generation = "crawl-skip-recovery";
      const nextArtist = "aaaaaaaaaaaaaaaaaaaaaa";
      await seedJob(generation, "artist_albums", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id) VALUES (?, ?)").bind(generation, nextArtist).run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await deliver({ generation, revision: 0 }, testEnv);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await jobRow(generation)).toMatchObject({ phase: "artist_albums", work_key: null, revision: 1 });
      expect(await env.DB.prepare("SELECT spotify_id FROM rebuild_seed_artists WHERE generation = ?").bind(generation).first()).toEqual({ spotify_id: nextArtist });
    });
  });

  describe("release tracks and enrichment", () => {
    it("splits album tracks into subrequest-safe enrichment batches and keeps the seed pipeline", async () => {
      const generation = "album-tracks";
      await seedJob(generation, "album_tracks", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name) VALUES (?, ?, ?, 'Album')").bind(generation, albumId, artistId).run();
      const { testEnv } = queueEnv();
      const tracks = Array.from({ length: 120 }, (_, index) => ({ id: trackId22(index + 1) }));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse(tracks)));
      await deliver({ generation, revision: 0 }, testEnv);
      const batches = await env.DB.prepare("SELECT seq, track_ids_json FROM rebuild_enrich_queue WHERE generation = ? ORDER BY seq").bind(generation).all<{ seq: number; track_ids_json: string }>();
      expect(batches.results.map((row) => (JSON.parse(row.track_ids_json) as string[]).length)).toEqual([30, 30, 30, 30]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_album_queue WHERE generation = ?").bind(generation).first()).toEqual({ count: 0 });
      // Draining the last release advances the machine to enrichment on the
      // next delivery; the read gap must have elapsed by then.
      await elapsePacing(generation);
      const drain = await deliver({ generation, revision: 1 }, testEnv);
      expect(drain.explicitAcks).toHaveLength(1);
      expect(await jobRow(generation)).toMatchObject({ phase: "enrich" });
    });

    it("queues the original track id when an album page is market-relinked", async () => {
      const generation = "album-tracks-relinked";
      const originalId = trackId22(31);
      const playableId = trackId22(32);
      await seedJob(generation, "album_tracks", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name) VALUES (?, ?, ?, 'Album')").bind(generation, albumId, artistId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(pageResponse([{ id: playableId, linked_from: { id: originalId } }])));

      await deliver({ generation, revision: 0 }, testEnv);

      const queued = await env.DB.prepare("SELECT track_ids_json FROM rebuild_enrich_queue WHERE generation = ?").bind(generation).first<{ track_ids_json: string }>();
      expect(JSON.parse(queued!.track_ids_json)).toEqual([originalId]);
    });

    it("re-slices an oversized legacy row and chunks relink aliases under D1's binding limit", async () => {
      const generation = "enrich-legacy-batch";
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      const ids = Array.from({ length: 40 }, (_, index) => trackId22(index + 1));
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify(ids)).run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse());
      for (const [index, id] of ids.slice(0, 30).entries()) {
        fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId22(index + 101), {
          external_ids: { isrc: `USABC${String(index).padStart(7, "0")}` },
          linked_from: { id },
        })), { headers: { "Content-Type": "application/json" } }));
      }
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      const queued = await env.DB.prepare("SELECT track_ids_json FROM rebuild_enrich_queue WHERE generation = ? AND seq = 1").bind(generation).first<{ track_ids_json: string }>();
      expect(fetchSpy).toHaveBeenCalledTimes(31);
      expect(JSON.parse(queued!.track_ids_json)).toEqual(ids.slice(30));
    });

    it("omits market entirely when the profile did not provide a country", async () => {
      const generation = "album-tracks-no-market";
      await seedJob(generation, "album_tracks", { market: null, workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name) VALUES (?, ?, ?, 'Album')").bind(generation, albumId, artistId).run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([]));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      const url = new URL(String(fetchSpy.mock.calls[1][0]));
      expect(url.pathname).toBe(`/v1/albums/${albumId}/tracks`);
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.has("market")).toBe(false);
    });

    it("enriches strictly playable tracks and keeps one representative per recording", async () => {
      const generation = "enrich-dedup";
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      const early = trackId22(1);
      const late = trackId22(2);
      const unplayable = trackId22(3);
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([early, late, unplayable])).run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(early)), { headers: { "Content-Type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(late, { album: { name: "Later pressing", release_date: "2021-06-01", images: [] } })), { headers: { "Content-Type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(unplayable, { is_playable: false })), { headers: { "Content-Type": "application/json" } }));
      vi.stubGlobal("fetch", fetchSpy);
      const result = await deliver({ generation, revision: 0 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      const staged = await env.DB.prepare("SELECT recording_key, spotify_id, release_date FROM recordings WHERE generation = ?").bind(generation).all<{ recording_key: string; spotify_id: string; release_date: string | null }>();
      // Both playable ids share an ISRC: only the earliest release is kept.
      expect(staged.results).toEqual([{ recording_key: "isrc:USABC2100001", spotify_id: early, release_date: "2020-01-01" }]);
      expect(fetchSpy.mock.calls.slice(1).map(([url]) => String(url))).toEqual([
        `https://api.spotify.com/v1/tracks/${early}?market=GR`,
        `https://api.spotify.com/v1/tracks/${late}?market=GR`,
        `https://api.spotify.com/v1/tracks/${unplayable}?market=GR`,
      ]);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/v1/tracks?ids="))).toBe(false);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_enrich_queue WHERE generation = ?").bind(generation).first<{ count: number }>()).toMatchObject({ count: 0 });
    });

    it("commits the skipped-track warning delta with enrichment queue progress", async () => {
      const generation = "enrich-skips";
      const missing = trackId22(4);
      const forbidden = trackId22(5);
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([missing, forbidden])).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(pageResponse([], null, 404))
        .mockResolvedValueOnce(pageResponse([], null, 403)));

      const result = await deliver({ generation, revision: 0 }, testEnv);

      expect(result.explicitAcks).toHaveLength(1);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_enrich_queue WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 0 });
      const state = await env.DB.prepare("SELECT warnings_json FROM refresh_state WHERE singleton = 1").first<{ warnings_json: string }>();
      expect(JSON.parse(state!.warnings_json)).toMatchObject({ trackBatchesUnavailable: 2 });
    });

    it("upgrades a legacy id-only Never decision before an ISRC recording can publish", async () => {
      const generation = "enrich-legacy-never";
      const legacyKey = `spotify:${trackId}`;
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([trackId])).run();
      await env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, NULL, ?, 1)").bind(legacyKey, trackId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId)), { headers: { "Content-Type": "application/json" } })));

      await deliver({ generation, revision: 0 }, testEnv);

      const exclusions = await env.DB.prepare("SELECT recording_key, isrc FROM never_recordings ORDER BY recording_key").all<{ recording_key: string; isrc: string | null }>();
      expect(exclusions.results).toEqual([{ recording_key: legacyKey, isrc: "USABC2100001" }]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_slots WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT live_generation, candidate_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ live_generation: null, candidate_count: 0 });
    });

    it("learns Never identity from the representative that loses same-batch deduplication", async () => {
      const generation = "enrich-never-losing-representative";
      const excludedId = trackId22(11);
      const winningId = trackId22(12);
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([excludedId, winningId])).run();
      await env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, NULL, ?, 1)").bind(`spotify:${excludedId}`, excludedId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(excludedId, { album: { name: "Later", release_date: "2021-01-01", images: [] } })), { headers: { "Content-Type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(winningId, { album: { name: "Earlier", release_date: "2019-01-01", images: [] } })), { headers: { "Content-Type": "application/json" } })));

      await deliver({ generation, revision: 0 }, testEnv);

      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation = ? AND recording_key = 'isrc:USABC2100001'").bind(generation).first()).toEqual({ spotify_id: winningId });
      expect(await env.DB.prepare("SELECT isrc FROM never_recordings WHERE spotify_id = ?").bind(excludedId).first()).toEqual({ isrc: "USABC2100001" });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_slots WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 0 });
    });

    it("learns Never identity from an unplayable alias before publishing a playable representative", async () => {
      const generation = "enrich-never-unplayable-alias";
      const excludedId = trackId22(13);
      const playableId = trackId22(14);
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([excludedId, playableId])).run();
      await env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, NULL, ?, 1)").bind(`spotify:${excludedId}`, excludedId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(excludedId, { is_playable: false })), { headers: { "Content-Type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(playableId)), { headers: { "Content-Type": "application/json" } })));

      await deliver({ generation, revision: 0 }, testEnv);

      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation = ? AND recording_key = 'isrc:USABC2100001'").bind(generation).first()).toEqual({ spotify_id: playableId });
      expect(await env.DB.prepare("SELECT isrc FROM never_recordings WHERE spotify_id = ?").bind(excludedId).first()).toEqual({ isrc: "USABC2100001" });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_slots WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 0 });
    });

    it("learns Never identity across Spotify market relinking", async () => {
      const generation = "enrich-never-relinked";
      const requestedId = trackId22(15);
      const playableId = trackId22(16);
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([requestedId])).run();
      await env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, NULL, ?, 1)").bind(`spotify:${requestedId}`, requestedId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(playableId, { linked_from: { id: requestedId } })), { headers: { "Content-Type": "application/json" } })));

      await deliver({ generation, revision: 0 }, testEnv);

      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation = ? AND recording_key = 'isrc:USABC2100001'").bind(generation).first()).toEqual({ spotify_id: playableId });
      expect(await env.DB.prepare("SELECT isrc FROM never_recordings WHERE spotify_id = ?").bind(requestedId).first()).toEqual({ isrc: "USABC2100001" });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_slots WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 0 });
    });

    it("publishes the first eligible records as a growing bootstrap shelf without deleting the job", async () => {
      const generation = "enrich-private";
      const firstRepresentative = trackId22(7);
      const wouldReplaceIt = trackId22(8);
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([firstRepresentative])).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(firstRepresentative)), { headers: { "Content-Type": "application/json" } })));
      await deliver({ generation, revision: 0 }, testEnv);
      const snapshot = await statusSnapshot(env);
      expect(snapshot).toMatchObject({ state: "active", refreshId: generation, candidateCount: 1 });
      expect(await env.DB.prepare("SELECT live_generation FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null }>()).toMatchObject({ live_generation: generation });
      expect(await env.DB.prepare("SELECT generation FROM recording_generations WHERE generation = ?").bind(generation).first()).toBeTruthy();
      expect(await jobRow(generation)).not.toBeNull();

      // A later batch finds an otherwise better representative for the same
      // ISRC. Because the first id may already be on a visitor's card, the live
      // bootstrap representative stays immutable and therefore resolvable.
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 2, ?, ?)").bind(generation, artistId, JSON.stringify([wouldReplaceIt])).run();
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(wouldReplaceIt, { album: { name: "Earlier", release_date: "2019-01-01", images: [] } })), { headers: { "Content-Type": "application/json" } })));
      await deliver({ generation, revision: 1 }, testEnv);
      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation = ? AND recording_key = 'isrc:USABC2100001'").bind(generation).first<{ spotify_id: string }>()).toEqual({ spotify_id: firstRepresentative });
    });

    it("does not publish a bootstrap shelf after a migration invalidates the delivery revision", async () => {
      const generation = "bootstrap-migration-race";
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([trackId])).run();
      const { testEnv } = queueEnv();
      const racedEnv = raceBeforeBatch(testEnv, 2, () => rerouteForMigration(generation));
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId)), { headers: { "Content-Type": "application/json" } })));

      await deliver({ generation, revision: 0 }, racedEnv);

      expect(await env.DB.prepare("SELECT live_generation, candidate_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ live_generation: null, candidate_count: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recording_generations WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 0 });
      expect(await jobRow(generation)).toMatchObject({ phase: "never_identities", revision: 1, dispatch_pending: 0 });
    });

    it("does not append to a live bootstrap shelf after a migration invalidates the delivery revision", async () => {
      const generation = "append-migration-race";
      const firstTrack = trackId22(17);
      const staleTrack = trackId22(18);
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([firstTrack])).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(firstTrack)), { headers: { "Content-Type": "application/json" } })));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 1, live_bucket_count: 1 });

      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 2, ?, ?)").bind(generation, artistId, JSON.stringify([staleTrack])).run();
      await elapsePacing(generation);
      const racedEnv = raceBeforeBatch(testEnv, 2, () => rerouteForMigration(generation));
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(staleTrack, { external_ids: { isrc: "USABC2100002" } })), { headers: { "Content-Type": "application/json" } })));

      await deliver({ generation, revision: 1 }, racedEnv);

      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_slots WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 1 });
      expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 1, live_bucket_count: 1 });
      expect(await env.DB.prepare("SELECT track_count FROM recommendation_buckets WHERE generation = ? AND bucket_artist_id = ?").bind(generation, artistId).first()).toEqual({ track_count: 1 });
      expect(await jobRow(generation)).toMatchObject({ phase: "never_identities", revision: 2, dispatch_pending: 0 });
    });
  });

  describe("resumable metadata work", () => {
    async function queueTracks(generation: string, ids: string[], market: string | null = "GR") {
      await seedJob(generation, "enrich", { market, workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES (?, 1, ?, ?)")
        .bind(generation, artistId, JSON.stringify(ids)).run();
    }

    it("checkpoints successes in a quota-failed group and resumes only unfinished ids", async () => {
      const generation = "partial-quota";
      const ids = Array.from({ length: 8 }, (_, i) => trackId22(i + 1));
      await queueTracks(generation, ids);
      await stageRecording("existing-live", "existing", trackId22(100));
      await setLive("existing-live");
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(ids[0]!))))
        .mockResolvedValueOnce(quotaResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(ids[2]!, { external_ids: { isrc: "USABC2100003" } }))))
        .mockResolvedValueOnce(pageResponse([], null, 404))
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(ids[4]!, { is_playable: false }))));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetchSpy).toHaveBeenCalledTimes(6); // No later group starts after quota.
      expect((await statusSnapshot(env))).toMatchObject({ state: "waiting", waitReason: "quota", refreshId: generation });
      const remaining = [ids[1], ...ids.slice(5)];
      expect(await env.DB.prepare("SELECT track_ids_json FROM rebuild_enrich_queue WHERE generation = ?").bind(generation).first()).toEqual({ track_ids_json: JSON.stringify(remaining) });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM recordings WHERE generation = ?").bind(generation).first()).toEqual({ count: 2 });
      expect(await env.DB.prepare("SELECT live_generation FROM refresh_state").first()).toEqual({ live_generation: "existing-live" });
      expect((await statusSnapshot(env)).warnings).toEqual(["1 tracks unavailable"]);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 900 });
      await elapsePacing(generation);
      const retryFetch = vi.fn().mockResolvedValueOnce(tokenResponse());
      for (const [i, id] of remaining.entries()) retryFetch.mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(id!, { external_ids: { isrc: `USABC21000${String(i + 10).padStart(2, "0")}` } }))));
      vi.stubGlobal("fetch", retryFetch);
      await deliver({ generation, revision: 1 }, testEnv);
      expect(retryFetch.mock.calls.slice(1).map(([url]) => new URL(String(url)).pathname.split("/").at(-1))).toEqual(remaining.slice(0, 1));
      expect(await env.DB.prepare("SELECT track_ids_json FROM rebuild_enrich_queue").first()).toEqual({ track_ids_json: JSON.stringify(remaining.slice(1)) });
      expect(await env.DB.prepare("SELECT quota_attempts FROM rebuild_jobs").first()).toEqual({ quota_attempts: 0 });
      await elapsePacing(generation);
      const rest = vi.fn().mockResolvedValueOnce(tokenResponse());
      remaining.slice(1).forEach((id, i) => rest.mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(id!, { external_ids: { isrc: `USABC21000${String(i + 20).padStart(2, "0")}` } })))));
      vi.stubGlobal("fetch", rest);
      await deliver({ generation, revision: 2 }, testEnv);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_enrich_queue").first()).toEqual({ count: 0 });
      expect(await statusSnapshot(env)).toMatchObject({ state: "active", refreshId: generation });
      expect((await statusSnapshot(env)).waitReason).toBeUndefined();
      expect((await statusSnapshot(env)).warnings).toEqual(["1 tracks unavailable"]);
    });

    it("reuses fresh metadata across generations without refreshing tokens or extending cache expiry", async () => {
      await queueTracks("cache-source", [trackId]);
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId)))));
      await deliver({ generation: "cache-source", revision: 0 }, testEnv);
      const cached = await env.DB.prepare("SELECT expires_at FROM spotify_track_cache").first();
      await env.DB.prepare("DELETE FROM rebuild_jobs").run();
      await queueTracks("cache-reuse", [trackId]);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation: "cache-reuse", revision: 0 }, testEnv);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation = 'cache-reuse'").first()).toEqual({ spotify_id: trackId });
      expect(await env.DB.prepare("SELECT expires_at FROM spotify_track_cache").first()).toEqual(cached);
    });

    it("separates reusable identity from daily availability and refuses changed relinks", async () => {
      const day = 86400000; const start = Date.now(); let time = start;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
      try {
        await writeTrackCache(env, "GR", [{ id: trackId, track: fullTrack(trackId) }]);
        const identity = await env.DB.prepare("SELECT track_json,expires_at FROM recording_identity_cache").first<{ track_json: string; expires_at: number }>();
        expect(JSON.parse(identity!.track_json)).not.toHaveProperty("is_playable");
        time = start + 7 * day;
        expect((await readTrackCache(env, "GR", [trackId])).size).toBe(0);
        await env.DB.prepare("INSERT INTO track_availability VALUES (?, 'GR', ?, ?, ?, ?)")
          .bind(env.OWNER_SPOTIFY_ID, trackId, trackId, JSON.stringify({ is_playable: false, is_local: false }), time + day).run();
        expect((await readTrackCache(env, "GR", [trackId])).get(trackId)).toMatchObject({ id: trackId, is_playable: false });
        await env.DB.prepare("UPDATE track_availability SET returned_id = ?").bind(trackId22(99)).run();
        expect((await readTrackCache(env, "GR", [trackId])).size).toBe(0);
        await env.DB.prepare("UPDATE track_availability SET returned_id = ?").bind(trackId).run();
        expect(await env.DB.prepare("SELECT track_json,expires_at FROM recording_identity_cache").first()).toEqual(identity);
        time = start + 31 * day;
        await env.DB.prepare("UPDATE track_availability SET expires_at = ?").bind(time + day).run();
        expect((await readTrackCache(env, "GR", [trackId])).size).toBe(0);
      } finally { clock.mockRestore(); }
    });

    it("uses the newest availability observation when a full response and album page overlap", async () => {
      let time = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
      try {
        await writeTrackCache(env, "GR", [{ id: trackId, track: fullTrack(trackId) }]);
        time += 3600000;
        await env.DB.prepare("INSERT INTO track_availability VALUES (?, 'GR', ?, ?, ?, ?)")
          .bind(env.OWNER_SPOTIFY_ID, trackId, trackId, JSON.stringify({ is_playable: false, is_local: false }), time + 86400000).run();
        expect((await readTrackCache(env, "GR", [trackId])).get(trackId)).toMatchObject({ is_playable: false });
        time += 60000;
        await writeTrackCache(env, "GR", [{ id: trackId, track: fullTrack(trackId) }]);
        expect((await readTrackCache(env, "GR", [trackId])).get(trackId)).toMatchObject({ is_playable: true });
        time += 60000;
        await env.DB.prepare("UPDATE track_availability SET returned_id=?,expires_at=?")
          .bind(trackId22(99), time + 86400000).run();
        expect((await readTrackCache(env, "GR", [trackId])).size).toBe(0);
      } finally { clock.mockRestore(); }
    });

    it.each(["expired", "market", "owner", "corrupt"])("refetches metadata for a %s cache miss", async (miss) => {
      const generation = `cache-miss-${miss}`;
      await queueTracks(generation, [trackId]);
      await env.DB.prepare("INSERT INTO spotify_track_cache VALUES (?, ?, ?, ?, ?)").bind(
        miss === "owner" ? "other-owner" : env.OWNER_SPOTIFY_ID,
        miss === "market" ? "US" : "GR", trackId,
        miss === "corrupt" ? "bad-json" : JSON.stringify(fullTrack(trackId)),
        miss === "expired" ? Date.now() - 1 : Date.now() + 60_000,
      ).run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId))));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation = ?").bind(generation).first()).toEqual({ spotify_id: trackId });
    });

    it("replays cached metadata after a staging interruption without repeating Spotify reads", async () => {
      const generation = "cache-crash-replay";
      await queueTracks(generation, [trackId]);
      const { testEnv } = queueEnv();
      const interrupted = raceBeforeBatch(testEnv, 2, async () => { throw new Error("staging interrupted"); });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId)))));
      await deliver({ generation, revision: 0 }, interrupted);
      expect(await env.DB.prepare("SELECT spotify_id FROM spotify_track_cache").first()).toEqual({ spotify_id: trackId });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_enrich_queue").first()).toEqual({ count: 1 });
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn());
      await deliver({ generation, revision: 1 }, testEnv);
      expect(fetch).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation = ?").bind(generation).first()).toEqual({ spotify_id: trackId });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_enrich_queue").first()).toEqual({ count: 0 });
    });

    it("keeps requested-id identity when reusing a relinked track from cache", async () => {
      const playableId = trackId22(200);
      await queueTracks("cache-relink", [trackId]);
      await env.DB.prepare("INSERT INTO never_recordings VALUES (?, NULL, ?, 1)").bind(`spotify:${trackId}`, trackId).run();
      await env.DB.prepare("INSERT INTO spotify_track_cache VALUES (?, 'GR', ?, ?, ?)")
        .bind(env.OWNER_SPOTIFY_ID, trackId, JSON.stringify(fullTrack(playableId)), Date.now() + 60_000).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn());
      await deliver({ generation: "cache-relink", revision: 0 }, testEnv);
      expect(fetch).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT isrc FROM never_recordings WHERE spotify_id = ?").bind(trackId).first()).toEqual({ isrc: "USABC2100001" });
      expect((await statusSnapshot(env)).candidateCount).toBe(0);
    });

    it("checkpoints partial Never identity results before quota waiting", async () => {
      const generation = "never-partial-quota";
      await seedJob(generation, "never_identities", { market: "GR" });
      for (const id of [trackId22(1), trackId22(2)]) await env.DB.prepare("INSERT INTO never_recordings VALUES (?, NULL, ?, 1)").bind(`spotify:${id}`, id).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId22(1)))))
        .mockResolvedValueOnce(quotaResponse()));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await env.DB.prepare("SELECT spotify_id FROM never_identity_checks").all()).toMatchObject({ results: [{ spotify_id: trackId22(1) }] });
      expect(await statusSnapshot(env)).toMatchObject({ state: "waiting", waitReason: "quota" });
      await elapsePacing(generation);
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId22(2)))));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 1 }, testEnv);
      expect(String(fetchSpy.mock.calls[1][0])).toContain(trackId22(2));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("keeps 30-track live appends with relink aliases within 30 D1 statements", async () => {
      const generation = "budget-live";
      const ids = Array.from({ length: 30 }, (_, i) => trackId22(i + 1));
      await queueTracks(generation, ids);
      await setLive(generation);
      let queries = 0;
      const { testEnv } = queueEnv();
      const limited = { ...testEnv, DB: new Proxy(testEnv.DB, { get(target, property) {
        if (property === "prepare") return (sql: string) => { expect(++queries).toBeLessThanOrEqual(25); return target.prepare(sql); };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } }) };
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse());
      for (const [i, id] of ids.entries()) fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId22(i + 100), {
        linked_from: { id }, external_ids: { isrc: `USABC${String(i).padStart(7, "0")}` },
      }))));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, limited);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM recommendation_slots WHERE generation = ?").bind(generation).first()).toEqual({ count: 30 });
      expect((await statusSnapshot(env)).candidateCount).toBe(30);
      expect(queries).toBeLessThanOrEqual(30);
    });
  });

  describe("quota-saving refresh work", () => {
    async function queuePlaylist(generation: string, snapshot = "snapshot-A") {
      await seedJob(generation, "known_playlists", { market: "GR", cursor: PLAYLISTS_URL });
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { id: playlistId, owner: { id: ownerUserId }, snapshot_id: snapshot },
      ])));
      await deliver({ generation, revision: 0 }, testEnv);
      await elapsePacing(generation);
      return { testEnv, send };
    }

    async function queueEnrichment(generation: string, ids: string[]) {
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify(ids)).run();
    }

    async function cachePlaylist(snapshot = "snapshot-A", context?: string, completed = Date.now()) {
      context ??= await catalogueContext(env, "GR");
      await env.DB.prepare("INSERT INTO playlist_snapshots VALUES (?, ?, ?, ?)").bind(context, playlistId, snapshot, completed).run();
      await env.DB.prepare("INSERT INTO playlist_snapshot_pages VALUES (?, ?, ?, ?, ?)")
        .bind(context, playlistId, snapshot, "first-page", JSON.stringify([{ id: trackId, key: "isrc:USABC2100001" }])).run();
    }

    it("reuses a complete unchanged playlist without a single item read", async () => {
      await cachePlaylist();
      const generation = "snapshot-reuse";
      const { testEnv } = await queuePlaylist(generation);
      expect(await env.DB.prepare("SELECT status FROM rebuild_playlist_queue").first()).toEqual({ status: "reuse" });
      const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 1 }, testEnv);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT recording_key FROM rebuild_known_recordings WHERE generation = ?").bind(generation).first()).toEqual({ recording_key: "isrc:USABC2100001" });
      expect(await env.DB.prepare("SELECT spotify_id FROM rebuild_known_tracks WHERE generation = ?").bind(generation).first()).toEqual({ spotify_id: trackId });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_playlist_queue").first()).toEqual({ count: 0 });
    });

    it.each(["changed", "expired", "owner", "market"])("scans a playlist when its cached snapshot is %s", async (reason) => {
      let context = await catalogueContext(reason === "owner" ? { ...env, OWNER_SPOTIFY_ID: "different-owner" } : env, reason === "market" ? "US" : "GR");
      await cachePlaylist(reason === "changed" ? "snapshot-old" : "snapshot-A", context, reason === "expired" ? Date.now() - 31 * 86400000 : Date.now());
      const generation = `snapshot-miss-${reason}`;
      await queuePlaylist(generation);
      expect(await env.DB.prepare("SELECT status FROM rebuild_playlist_queue").first()).toEqual({ status: "pending" });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_known_recordings WHERE generation = ?").bind(generation).first()).toEqual({ count: 0 });
    });

    it("never reuses unverified partial playlist pages", async () => {
      const generation = "snapshot-partial";
      const { testEnv } = await queuePlaylist(generation);
      const next = `https://api.spotify.com/v1/playlists/${playlistId}/items?offset=50`;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { item: { id: trackId, external_ids: { isrc: "USABC2100001" } } },
      ], next)));
      await deliver({ generation, revision: 1 }, testEnv);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM playlist_snapshots").first()).toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM playlist_snapshot_pages").first()).toEqual({ count: 1 });
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 503)));
      await deliver({ generation, revision: 2 }, testEnv);
      expect(await env.DB.prepare("SELECT cursor FROM rebuild_playlist_queue").first()).toEqual({ cursor: next });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM playlist_snapshots").first()).toEqual({ count: 0 });
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { item: { id: trackId22(2), external_ids: { isrc: "USABC2100002" } } },
      ])));
      await deliver({ generation, revision: 3 }, testEnv);
      expect(await env.DB.prepare("SELECT status FROM rebuild_playlist_queue").first()).toEqual({ status: "verify" });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM playlist_snapshots").first()).toEqual({ count: 0 });
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ snapshot_id: "snapshot-A" }))));
      await deliver({ generation, revision: 4 }, testEnv);
      expect(await env.DB.prepare("SELECT snapshot_id FROM playlist_snapshots").first()).toEqual({ snapshot_id: "snapshot-A" });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM playlist_snapshot_pages").first()).toEqual({ count: 2 });
      // A later generation can now reuse this verified version without Spotify.
      await env.DB.prepare("DELETE FROM rebuild_jobs").run();
      const fresh = await queuePlaylist("snapshot-next");
      vi.stubGlobal("fetch", vi.fn());
      await deliver({ generation: "snapshot-next", revision: 1 }, fresh.testEnv);
      await deliver({ generation: "snapshot-next", revision: 2 }, fresh.testEnv);
      expect(fetch).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_known_recordings WHERE generation = 'snapshot-next'").first()).toEqual({ count: 2 });
    });

    it("does not publish a playlist snapshot edited while paging", async () => {
      const generation = "snapshot-edit";
      const { testEnv } = await queuePlaylist(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ item: { id: trackId, external_ids: { isrc: "USABC2100001" } } }])));
      await deliver({ generation, revision: 1 }, testEnv);
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ snapshot_id: "snapshot-B" }))));
      await deliver({ generation, revision: 2 }, testEnv);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM playlist_snapshots").first()).toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM playlist_snapshot_pages").first()).toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT recording_key FROM rebuild_known_recordings WHERE generation = ?").bind(generation).first()).toEqual({ recording_key: "isrc:USABC2100001" });
    });

    it("caches a genuinely empty playlist only after version verification", async () => {
      const generation = "snapshot-empty";
      const { testEnv } = await queuePlaylist(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([])));
      await deliver({ generation, revision: 1 }, testEnv);
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ snapshot_id: "snapshot-A" }))));
      await deliver({ generation, revision: 2 }, testEnv);
      expect(await env.DB.prepare("SELECT snapshot_id FROM playlist_snapshots").first()).toEqual({ snapshot_id: "snapshot-A" });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM playlist_snapshot_pages").first()).toEqual({ count: 1 });
    });

    it.each(["corrupt", "missing"])("rescans a %s playlist cache instead of treating it as empty", async (failure) => {
      await cachePlaylist();
      if (failure === "missing") await env.DB.prepare("DELETE FROM playlist_snapshot_pages").run();
      else await env.DB.prepare("UPDATE playlist_snapshot_pages SET tracks_json = 'broken-json'").run();
      const generation = `snapshot-invalid-${failure}`;
      const { testEnv } = await queuePlaylist(generation);
      vi.stubGlobal("fetch", vi.fn());
      await deliver({ generation, revision: 1 }, testEnv);
      expect(fetch).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT status, cursor FROM rebuild_playlist_queue").first()).toEqual({ status: "pending", cursor: null });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM playlist_snapshots").first()).toEqual({ count: 0 });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { item: { id: trackId, external_ids: { isrc: "USABC2100001" } } },
      ])));
      await deliver({ generation, revision: 2 }, testEnv);
      expect(await env.DB.prepare("SELECT recording_key FROM rebuild_known_recordings WHERE generation = ?").bind(generation).first()).toEqual({ recording_key: "isrc:USABC2100001" });
    });

    it("does not reuse a cached playlist that is no longer owned or collaborative", async () => {
      await cachePlaylist();
      const generation = "snapshot-permission";
      await seedJob(generation, "known_playlists", { cursor: PLAYLISTS_URL });
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { id: playlistId, owner: { id: "different-user" }, snapshot_id: "snapshot-A" },
      ])));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_playlist_queue").first()).toEqual({ count: 0 });
    });

    it("skips confirmed known ids in a legacy enrichment row without any Spotify traffic", async () => {
      const generation = "skip-known";
      await queueEnrichment(generation, [trackId]);
      await env.DB.prepare("INSERT INTO rebuild_known_tracks VALUES (?, ?, 'isrc:USABC2100001')").bind(generation, trackId).run();
      await env.DB.prepare("INSERT INTO rebuild_known_recordings VALUES (?, 'isrc:USABC2100001')").bind(generation).run();
      const { testEnv } = queueEnv(); vi.stubGlobal("fetch", vi.fn());
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetch).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_enrich_queue").first()).toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM recordings WHERE generation = ?").bind(generation).first()).toEqual({ count: 0 });
    });

    it("enriches id-only known tracks to exclude equivalent representatives recording-wide", async () => {
      const generation = "known-upgrade";
      const alternate = trackId22(99);
      await queueEnrichment(generation, [trackId, alternate]);
      await env.DB.prepare("INSERT INTO rebuild_known_tracks VALUES (?, ?, ?)").bind(generation, trackId, `spotify:${trackId}`).run();
      await env.DB.prepare("INSERT INTO rebuild_known_recordings VALUES (?, ?)").bind(generation, `spotify:${trackId}`).run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(trackId))))
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(alternate))));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(await env.DB.prepare("SELECT recording_key FROM rebuild_known_recordings WHERE generation = ? AND recording_key LIKE 'isrc:%'").bind(generation).first()).toEqual({ recording_key: "isrc:USABC2100001" });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM recordings WHERE generation = ?").bind(generation).first()).toEqual({ count: 0 });
    });

    it("reuses album discovery pages but filters the current generation's known tracks", async () => {
      const generation = "album-page-source";
      await seedJob(generation, "album_tracks", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name) VALUES (?, ?, ?, 'Album')").bind(generation, albumId, artistId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ id: trackId }, { id: trackId22(2) }])));
      await deliver({ generation, revision: 0 }, testEnv);
      await env.DB.prepare("DELETE FROM rebuild_jobs").run();
      await seedJob("album-page-reuse", "album_tracks", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name) VALUES ('album-page-reuse', ?, ?, 'Album')").bind(albumId, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_known_tracks VALUES ('album-page-reuse', ?, 'isrc:USABC2100001')").bind(trackId).run();
      vi.stubGlobal("fetch", vi.fn());
      await deliver({ generation: "album-page-reuse", revision: 0 }, testEnv);
      expect(fetch).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT track_ids_json FROM rebuild_enrich_queue WHERE generation = 'album-page-reuse'").first()).toEqual({ track_ids_json: JSON.stringify([trackId22(2)]) });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM album_track_pages").first()).toEqual({ count: 1 });
    });

    it.each(["expired", "market", "owner"])("refetches a %s album discovery page", async (miss) => {
      const generation = `album-cache-${miss}`;
      await seedJob(generation, "album_tracks", { market: "GR", workKey: artistId });
      const context = await catalogueContext(miss === "owner" ? { ...env, OWNER_SPOTIFY_ID: "other-owner" } : env, miss === "market" ? "US" : "GR");
      const cursor = `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=50&market=GR`;
      await env.DB.prepare("INSERT INTO album_track_pages VALUES (?, ?, ?, '[]', NULL, ?)").bind(context, albumId, cursor, miss === "expired" ? 1 : Date.now() + 60000).run();
      await env.DB.prepare("INSERT INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name) VALUES (?, ?, ?, 'Album')").bind(generation, albumId, artistId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ id: trackId }])));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await env.DB.prepare("SELECT track_ids_json FROM rebuild_enrich_queue WHERE generation = ?").bind(generation).first()).toEqual({ track_ids_json: JSON.stringify([trackId]) });
    });

    it("does not skip a newly discovered album merely because other releases were cached", async () => {
      const generation = "album-page-new";
      await seedJob(generation, "album_tracks", { market: "GR", workKey: artistId });
      const context = await catalogueContext(env, "GR");
      await env.DB.prepare("INSERT INTO album_track_pages VALUES (?, 'old-album', 'cursor', '[]', NULL, ?)").bind(context, Date.now() + 60000).run();
      await env.DB.prepare("INSERT INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name) VALUES (?, ?, ?, 'New album')").bind(generation, albumId, artistId).run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ id: trackId }]));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await env.DB.prepare("SELECT track_ids_json FROM rebuild_enrich_queue WHERE generation = ?").bind(generation).first()).toEqual({ track_ids_json: JSON.stringify([trackId]) });
    });

    it("shares an encrypted service token across deliveries and refreshes it at expiry", async () => {
      const generation = "token-reuse";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse(SERVICE_SCOPES, 3600)).mockResolvedValueOnce(pageResponse([])));
      await deliver({ generation, revision: 0 }, testEnv);
      const cached = await env.DB.prepare("SELECT ciphertext, expires_at FROM service_token_cache").first<{ ciphertext: string; expires_at: number }>();
      expect(cached).toBeTruthy();
      expect(cached!.ciphertext).not.toContain("access");
      expect(cached!.ciphertext).not.toContain(env.SPOTIFY_REFRESH_TOKEN);
      await elapsePacing(generation);
      const nextFetch = vi.fn().mockResolvedValueOnce(pageResponse([]));
      vi.stubGlobal("fetch", nextFetch);
      await deliver({ generation, revision: 1 }, testEnv);
      expect(nextFetch).toHaveBeenCalledTimes(1);
      expect(String(nextFetch.mock.calls[0][0])).toContain('/me/playlists');
      expect(await readServiceToken(env)).toEqual({ access_token: "access", scope: SERVICE_SCOPES });
      await env.DB.prepare("UPDATE service_token_cache SET expires_at = 1").run();
      expect(await readServiceToken(env)).toBeNull();
    });

    it.each(["owner", "refresh", "secret", "client"])("invalidates service token reuse after a %s credential change", async (change) => {
      await writeServiceToken(env, { access_token: "sensitive-token", scope: SERVICE_SCOPES }, 3600);
      const changed = { ...env,
        ...(change === "owner" ? { OWNER_SPOTIFY_ID: "new-owner" } : {}),
        ...(change === "refresh" ? { SPOTIFY_REFRESH_TOKEN: "new-refresh" } : {}),
        ...(change === "secret" ? { SESSION_SECRET: "new-session-secret" } : {}),
        ...(change === "client" ? { SPOTIFY_CLIENT_ID: "new-client" } : {}),
      };
      expect(await readServiceToken(changed)).toBeNull();
    });

    it("refreshes a rejected token once and retries the same page", async () => {
      const generation = "token-rejected";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      await writeServiceToken(env, { access_token: "old-token", scope: SERVICE_SCOPES }, 3600);
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(pageResponse([], null, 401)).mockResolvedValueOnce(tokenResponse(SERVICE_SCOPES, 3600)).mockResolvedValueOnce(pageResponse([]));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([LIKED_URL, "https://accounts.spotify.com/api/token", LIKED_URL]);
      expect(await jobRow(generation)).toMatchObject({ phase: "known_playlists", status: "active" });
    });

    it("treats a repeated 401 as a visible permanent error", async () => {
      const generation = "token-bad-credentials";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      await writeServiceToken(env, { access_token: "old-token", scope: SERVICE_SCOPES }, 3600);
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(pageResponse([], null, 401)).mockResolvedValueOnce(tokenResponse(SERVICE_SCOPES, 3600)).mockResolvedValueOnce(pageResponse([], null, 401));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(await jobRow(generation)).toMatchObject({ status: "failed", phase: "seeds" });
    });

    it("shares one token renewal among concurrent track requests", async () => {
      const generation = "token-concurrent-401";
      await queueEnrichment(generation, Array.from({ length: 6 }, (_, i) => trackId22(i + 1)));
      await writeServiceToken(env, { access_token: "old-token", scope: SERVICE_SCOPES }, 3600);
      const { testEnv } = queueEnv();
      let renewals = 0;
      const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("accounts.spotify.com")) { renewals++; return tokenResponse(SERVICE_SCOPES, 3600); }
        if (new Headers(init?.headers).get("Authorization") === "Bearer old-token") return pageResponse([], null, 401);
        return new Response(JSON.stringify(fullTrack(new URL(url).pathname.split('/').at(-1)!)));
      });
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(renewals).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(12);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_enrich_queue").first()).toEqual({ count: 0 });
      expect(await jobRow(generation)).toMatchObject({ status: "active", retry_count: 0 });
    });

    it("refreshes expired or corrupt token entries instead of leaking cache failures", async () => {
      const generation = "token-cache-invalid";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      await writeServiceToken(env, { access_token: "expired-token", scope: SERVICE_SCOPES }, 3600);
      await env.DB.prepare("UPDATE service_token_cache SET ciphertext = 'bad-json'").run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse(SERVICE_SCOPES, 3600)).mockResolvedValueOnce(pageResponse([]));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await readServiceToken(env)).toEqual({ access_token: "access", scope: SERVICE_SCOPES });
      await elapsePacing(generation);
      await env.DB.prepare("UPDATE service_token_cache SET expires_at = 1").run();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse(SERVICE_SCOPES, 3600)).mockResolvedValueOnce(pageResponse([])));
      await deliver({ generation, revision: 1 }, testEnv);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("reduces enrichment batch size and concurrency after rate limiting", async () => {
      const generation = "adaptive-enrich";
      const ids = Array.from({ length: 30 }, (_, i) => trackId22(i + 1));
      await queueEnrichment(generation, ids);
      await env.DB.prepare("UPDATE rebuild_jobs SET pace_multiplier = 2").run();
      const { testEnv, send } = queueEnv();
      let inFlight = 0, peak = 0;
      const fetchSpy = vi.fn(async (url: string) => {
        if (url.includes('accounts.spotify.com')) return tokenResponse();
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return new Response(JSON.stringify(fullTrack(new URL(url).pathname.split('/').at(-1)!)));
      });
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetchSpy).toHaveBeenCalledTimes(16);
      expect(peak).toBeLessThanOrEqual(2);
      expect(await env.DB.prepare("SELECT track_ids_json FROM rebuild_enrich_queue").first()).toEqual({ track_ids_json: JSON.stringify(ids.slice(15)) });
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 30 });
    });

    it("slows pacing after a rolling 429 and gradually recovers after clean units", async () => {
      const generation = "adaptive-pace";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 429, { "Retry-After": "1" })));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await env.DB.prepare("SELECT pace_multiplier FROM rebuild_jobs").first()).toEqual({ pace_multiplier: 2 });
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 4 });
      await env.DB.prepare("UPDATE rebuild_jobs SET pace_successes = 19").run();
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([])));
      await deliver({ generation, revision: 1 }, testEnv);
      expect(await env.DB.prepare("SELECT pace_multiplier, pace_successes FROM rebuild_jobs").first()).toEqual({ pace_multiplier: 1.8, pace_successes: 0 });
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 2 }, { contentType: "json", delaySeconds: 4 });
    });
  });

  describe("known-track scans", () => {
    it("enqueues owner-owned and collaborative playlists from discovery", async () => {
      const generation = "playlists-owned";
      await seedJob(generation, "known_playlists", { cursor: PLAYLISTS_URL, market: "GR" });
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { id: playlistId, owner: { id: ownerUserId } },
        { id: "3333333333333333333333", owner: { id: "someone-else" }, collaborative: true },
        { id: "4444444444444444444444" },
      ])));
      const result = await deliver({ generation, revision: 0 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      const queued = await env.DB.prepare("SELECT spotify_id FROM rebuild_playlist_queue WHERE generation = ?").bind(generation).all<{ spotify_id: string }>();
      expect(queued.results).toEqual([{ spotify_id: playlistId }, { spotify_id: "3333333333333333333333" }]);
      expect(await jobRow(generation)).toMatchObject({ phase: "known_playlist_items" });
    });

    it("reads the current playlist .item shape before discovery begins", async () => {
      const generation = "playlist-items-current";
      await seedJob(generation, "known_playlist_items", { market: null });
      await env.DB.prepare("INSERT INTO rebuild_playlist_queue (generation, spotify_id) VALUES (?, ?)").bind(generation, playlistId).run();
      const { testEnv } = queueEnv();
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { item: { id: trackId, external_ids: { isrc: "US-ABC-21-00001" } } },
      ]));
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await env.DB.prepare("SELECT recording_key FROM rebuild_known_recordings WHERE generation = ?").bind(generation).first<{ recording_key: string }>()).toEqual({ recording_key: "isrc:USABC2100001" });
      const url = new URL(String(fetchSpy.mock.calls[1][0]));
      expect(url.pathname).toBe(`/v1/playlists/${playlistId}/items`);
      expect(url.searchParams.has("market")).toBe(false);
      await elapsePacing(generation);
      await deliver({ generation, revision: 1 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "artist_albums" });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_playlist_queue WHERE generation = ?").bind(generation).first()).toEqual({ count: 0 });
    });

    it("treats the final liked scan as authoritative known tracks", async () => {
      const generation = "known-liked";
      await seedJob(generation, "known_liked", { cursor: LIKED_URL });
      await env.DB.prepare("INSERT INTO recordings (generation, recording_key, spotify_id, isrc, title, album_name, release_date, image_url, spotify_url, artists_json, bucket_artist_id) VALUES (?, 'isrc:USABC2100001', ?, NULL, 'Staged', 'Album', NULL, NULL, ?, '[]', ?)").bind(generation, trackId, `https://open.spotify.com/track/${trackId}`, artistId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { track: { id: trackId, external_ids: { isrc: "US-ABC-21-00001" } } },
        { track: { id: trackId22(9), is_local: true } },
      ])));
      await deliver({ generation, revision: 0 }, testEnv);
      const known = await env.DB.prepare("SELECT recording_key FROM rebuild_known_recordings WHERE generation = ?").bind(generation).all<{ recording_key: string }>();
      expect(known.results).toEqual([{ recording_key: "isrc:USABC2100001" }]);
      expect(await jobRow(generation)).toMatchObject({ phase: "promote" });
    });
  });

  describe("bootstrap phase order", () => {
    it("scans known sources first, then completes one seed through enrichment before the next", async () => {
      const generation = "interleaved-seeds";
      const firstSeed = otherArtistId;
      const secondSeed = artistId;
      const discovered = trackId22(21);
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv } = queueEnv();

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { track: { id: trackId, artists: [{ id: secondSeed, name: "Second" }] } },
        { track: { id: trackId22(3), artists: [{ id: firstSeed, name: "First" }] } },
      ])));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "known_playlists" });

      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([])));
      await deliver({ generation, revision: 1 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "known_playlist_items" });

      await elapsePacing(generation);
      await deliver({ generation, revision: 2 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "artist_albums", work_key: null });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ id: albumId, name: "First album", images: [] }])));
      await deliver({ generation, revision: 3 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "album_tracks", work_key: firstSeed });
      expect(await env.DB.prepare("SELECT status FROM rebuild_seed_artists WHERE generation = ? AND spotify_id = ?").bind(generation, secondSeed).first<{ status: string }>()).toEqual({ status: "pending" });

      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ id: discovered }])));
      await deliver({ generation, revision: 4 }, testEnv);
      await elapsePacing(generation);
      await deliver({ generation, revision: 5 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "enrich", work_key: firstSeed });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(discovered)), { headers: { "Content-Type": "application/json" } })));
      await deliver({ generation, revision: 6 }, testEnv);
      expect(await env.DB.prepare("SELECT live_generation FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null }>()).toEqual({ live_generation: generation });
      expect(await jobRow(generation)).toMatchObject({ phase: "enrich", work_key: firstSeed });

      await elapsePacing(generation);
      await deliver({ generation, revision: 7 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "artist_albums", work_key: null });
      expect(await env.DB.prepare("SELECT status FROM rebuild_seed_artists WHERE generation = ? AND spotify_id = ?").bind(generation, firstSeed).first<{ status: string }>()).toBeNull();

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([])));
      await deliver({ generation, revision: 8 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ phase: "album_tracks", work_key: secondSeed });
    });
  });

  describe("pacing, retries, and rate limits", () => {
    it("defers a delivery that arrives before the durable data-read gap", async () => {
      const generation = "pacing";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ track: { id: trackId, artists: [{ id: artistId, name: "Artist" }] } }])));
      await deliver({ generation, revision: 0 }, testEnv);
      send.mockClear();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const result = await deliver({ generation, revision: 1 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      const delay = (send.mock.calls[0][1] as { delaySeconds: number }).delaySeconds;
      expect(delay).toBeGreaterThanOrEqual(1);
      expect(delay).toBeLessThanOrEqual(2);
    });

    it("honors Retry-After on 429 without consuming a retry attempt", async () => {
      const generation = "rate-limit";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      const before = Date.now();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 429, { "Retry-After": "3600" })));
      const result = await deliver({ generation, revision: 0 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      const job = await jobRow(generation);
      expect(job).toMatchObject({ status: "active", phase: "seeds", cursor: LIKED_URL, revision: 1, retry_count: 0 });
      expect(job!.retry_at).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 3600 });
      const snapshot = await statusSnapshot(env);
      expect(snapshot).toMatchObject({ state: "waiting", retryAfterSeconds: 3600 });
    });

    it("persists exponential attempts for 5xx failures and resets after success", async () => {
      const generation = "retry-5xx";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      let before = Date.now();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 503)));
      await deliver({ generation, revision: 0 }, testEnv);
      let job = await jobRow(generation);
      expect(job).toMatchObject({ status: "active", retry_count: 1, revision: 1, cursor: LIKED_URL });
      expect(job!.retry_at).toBeGreaterThanOrEqual(before + 30_000);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 30 });

      // The persisted retry cooldown gates the redelivery; once it elapses the
      // second failure lands on the persisted second attempt.
      await elapsePacing(generation);
      before = Date.now();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 500)));
      await deliver({ generation, revision: 1 }, testEnv);
      job = await jobRow(generation);
      expect(job).toMatchObject({ retry_count: 2, revision: 2 });
      expect(job!.retry_at).toBeGreaterThanOrEqual(before + 60_000);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 2 }, { contentType: "json", delaySeconds: 60 });

      // A later successful unit starts a fresh retry budget.
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ track: { id: trackId, artists: [{ id: artistId, name: "Artist" }] } }])));
      await deliver({ generation, revision: 2 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ retry_count: 0, phase: "known_playlists" });
    });

    it("takes an hourly pause after five transient failures while keeping the same job", async () => {
      const generation = "retry-exhausted";
      await seedJob(generation, "seeds", { cursor: LIKED_URL, revision: 4, retryCount: 4 });
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 500)));
      const result = await deliver({ generation, revision: 4 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      expect(await jobRow(generation)).toMatchObject({ status: "active", retry_count: 0, revision: 5 });
      const state = await env.DB.prepare("SELECT last_error, last_outcome FROM refresh_state WHERE singleton = 1").first<{ last_error: string | null; last_outcome: string | null }>();
      expect(state).toEqual({ last_error: null, last_outcome: null });
      expect(await statusSnapshot(env)).toMatchObject({ state: "waiting", waitReason: "upstream" });
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 5 }, { contentType: "json", delaySeconds: 3600 });
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([])));
      await deliver({ generation, revision: 5 }, testEnv);
      expect(await statusSnapshot(env)).toMatchObject({ state: "active", refreshId: generation });
    });

    it("does not let a stale systemic failure fail a migration-rerouted job or global status", async () => {
      const generation = "failure-migration-race";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv } = queueEnv();
      const racedEnv = raceBeforeBatch(testEnv, 1, () => rerouteForMigration(generation));
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(pageResponse([], null, 400)));

      await deliver({ generation, revision: 0 }, racedEnv);

      expect(await jobRow(generation)).toMatchObject({ status: "active", phase: "never_identities", revision: 1, dispatch_pending: 0 });
      expect(await env.DB.prepare("SELECT last_error, last_outcome FROM refresh_state WHERE singleton = 1").first()).toEqual({ last_error: null, last_outcome: null });
    });

    it("saves an initial quota backoff without consuming attempts or erasing cursors", async () => {
      const generation = "quota-exceeded";
      await seedJob(generation, "seeds", { cursor: LIKED_URL, retryCount: 3 });
      const { testEnv, send } = queueEnv();
      const before = Date.now();
      // Also accept Spotify's top-level reason variant.
      const quota = new Response(JSON.stringify({ error: { status: 429, message: "quota" }, reason: "QUOTA_EXCEEDED" }), { status: 429 });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(quota));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ status: "active", cursor: LIKED_URL, revision: 1, retry_count: 3, dispatch_pending: 0 });
      const snapshot = await statusSnapshot(env);
      expect(snapshot).toMatchObject({ state: "waiting", waitReason: "quota" });
      expect(snapshot.retryAt).toBeGreaterThanOrEqual(before + 900_000);
      expect(snapshot.error).toBeUndefined();
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 900 });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      await deliver({ generation, revision: 1 }, testEnv);
      await startOrWakeRebuild(testEnv);
      await tick(testEnv);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await jobRow(generation)).toMatchObject({ status: "active", revision: 1, cursor: LIKED_URL });
    });

    it("honors quota Retry-After beyond the queue's maximum message delay", async () => {
      const generation = "long-quota";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(quotaResponse(172_800)));
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).retryAfterSeconds).toBeGreaterThan(172_790);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 43_200 });
      // The early wake is re-delayed against D1's full deadline, with no read.
      vi.stubGlobal("fetch", vi.fn());
      await deliver({ generation, revision: 1 }, testEnv);
      expect(fetch).not.toHaveBeenCalled();
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: "json", delaySeconds: 43_200 });
    });

  });

  describe("stale and duplicate deliveries", () => {
    it("acks a message for another generation without any work", async () => {
      const generation = "stale-generation";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const result = await deliver({ generation: "gone-generation", revision: 0 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it("acks a stale revision without regressing the cursor or re-doing work", async () => {
      const generation = "stale-revision";
      await seedJob(generation, "seeds", { cursor: LIKED_URL, revision: 3 });
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const result = await deliver({ generation, revision: 1 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(await jobRow(generation)).toMatchObject({ revision: 3, cursor: LIKED_URL });
    });

    it("re-dispatches the current revision when a dispatch is still pending", async () => {
      const generation = "pending-dispatch";
      await seedJob(generation, "seeds", { cursor: LIKED_URL, revision: 5, retryAt: Date.now() + 120_000, dispatchPending: 1 });
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const result = await deliver({ generation, revision: 4 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toEqual({ generation, revision: 5 });
    });

    it("retries later instead of overlapping while another consumer holds the lease", async () => {
      const generation = "leased";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      await env.DB.prepare("UPDATE rebuild_jobs SET lease_until = ? WHERE generation = ?").bind(Date.now() + 120_000, generation).run();
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn();
      const ack = vi.fn();
      const retry = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      if (!worker.queue) throw new Error("queue handler missing");
      await worker.queue({
        queue: "ferto-refresh",
        messages: [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { generation, revision: 0 }, ack, retry }],
      } as unknown as MessageBatch<RefreshMessage>, testEnv);
      expect(retry).toHaveBeenCalledTimes(1);
      const delay = (retry.mock.calls[0][0] as { delaySeconds: number }).delaySeconds;
      expect(delay).toBeGreaterThanOrEqual(120);
      expect(delay).toBeLessThanOrEqual(122);
      expect(ack).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(await jobRow(generation)).toMatchObject({ revision: 0 });
    });
  });

  describe("incremental publication", () => {
    async function publicationFixture(generation: string) {
      await stageRecording('old-public', 'old', trackId22(1));
      await env.DB.prepare("INSERT INTO recording_generations VALUES ('old-public',1)").run();
      await setLive('old-public');
      await rebuildRecommendationPool(env, 'old-public');
      await env.DB.prepare("UPDATE refresh_state SET candidate_count=(SELECT count(*) FROM recommendation_slots WHERE generation='old-public'),live_bucket_count=(SELECT count(*) FROM recommendation_buckets WHERE generation='old-public') WHERE singleton=1").run();
      await seedJob(generation, 'enrich', { workKey: otherArtistId });
      await env.DB.prepare("INSERT INTO refresh_history(generation,base_generation,started_at) VALUES (?,'old-public',1)").bind(generation).run();
      await env.DB.prepare("INSERT INTO rebuild_seed_artists(generation,spotify_id,status) VALUES (?,?,'catalogued')").bind(generation, otherArtistId).run();
      await stageRecording(generation, 'new', trackId22(2), otherArtistId);
      return queueEnv().testEnv;
    }

    it('makes only new eligible completed-artist recordings public and preserves existing cards', async () => {
      const generation = 'early-artist';
      const testEnv = await publicationFixture(generation);
      await stageRecording(generation, 'old', trackId22(3), otherArtistId);
      // Upgraded identities must not duplicate an existing Spotify id under
      // a different recording key while the original card is still live.
      await stageRecording(generation, 'old-canonical-alias', trackId22(1), otherArtistId);
      await stageRecording(generation, 'liked', trackId22(4), otherArtistId);
      await stageRecording(generation, 'removed', trackId22(5), otherArtistId);
      await stageRecording(generation, 'live-known', trackId22(6), otherArtistId);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO rebuild_known_recordings VALUES (?, 'liked')").bind(generation),
        env.DB.prepare("INSERT INTO rebuild_known_recordings VALUES ('old-public', 'live-known')"),
        env.DB.prepare("INSERT INTO never_recordings(recording_key,spotify_id,excluded_at) VALUES ('removed',?,1)").bind(trackId22(5)),
      ]);
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Publication must not call Spotify'); }));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await statusSnapshot(env)).toMatchObject({ state: 'active', candidateCount: 2,
        progress: { publishedRecordings: 1, publishedArtists: 1, seedArtistsDone: 1 } });
      expect((await statusSnapshot(env)).lastPublicationAt).toBeGreaterThan(0);
      expect((await env.DB.prepare("SELECT recording_key FROM recommendation_slots WHERE generation='old-public' ORDER BY recording_key").all()).results)
        .toEqual([{ recording_key: 'new' }, { recording_key: 'old' }]);
      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation='old-public' AND recording_key='old'").first()).toEqual({ spotify_id: trackId22(1) });
      expect(await jobRow(generation)).toBeTruthy();
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(2);
      expect((await statusSnapshot(env)).progress.publishedRecordings).toBe(1);
    });

    it('does not treat an unfinished artist as completed', async () => {
      const generation = 'unfinished-artist';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare("UPDATE rebuild_seed_artists SET status='pending',cursor='another-page' WHERE generation=?").bind(generation).run();
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(1);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM refresh_publications").first()).toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT cursor FROM rebuild_seed_artists WHERE generation=?").bind(generation).first()).toEqual({ cursor: 'another-page' });
    });

    it('publishes a successful song batch before artist completion even when a sibling request hits quota', async () => {
      const generation = 'partial-batch-publication';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare('DELETE FROM recordings WHERE generation=?').bind(generation).run();
      await env.DB.prepare("UPDATE rebuild_seed_artists SET status='pending',cursor='next-release-page' WHERE generation=?").bind(generation).run();
      const ids = [trackId22(31), trackId22(32)];
      await env.DB.prepare('INSERT INTO rebuild_enrich_queue(generation,seq,bucket_artist_id,track_ids_json) VALUES (?,1,?,?)')
        .bind(generation, otherArtistId, JSON.stringify(ids)).run();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(ids[0]!))))
        .mockResolvedValueOnce(quotaResponse(86400)));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await statusSnapshot(env)).toMatchObject({ state: 'waiting', candidateCount: 2,
        progress: { publishedRecordings: 1, publishedArtists: 1, tracksProcessed: 1 } });
      expect((await statusSnapshot(env)).progress.seedArtistsDone ?? 0).toBe(0);
      expect(await env.DB.prepare('SELECT track_ids_json FROM rebuild_enrich_queue').first()).toEqual({ track_ids_json: JSON.stringify([ids[1]]) });
      expect(await env.DB.prepare('SELECT status,cursor FROM rebuild_seed_artists').first()).toEqual({ status: 'pending', cursor: 'next-release-page' });
    });

    it('keeps an early card immutable when a later batch finds a better representative', async () => {
      const generation = 'batch-representatives';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare('DELETE FROM recordings WHERE generation=?').bind(generation).run();
      for (const [revision, id] of [trackId22(31), trackId22(32)].entries()) {
        await env.DB.prepare('INSERT INTO rebuild_enrich_queue(generation,seq,bucket_artist_id,track_ids_json) VALUES (?,?,?,?)')
          .bind(generation, revision + 1, otherArtistId, JSON.stringify([id])).run();
        await elapsePacing(generation);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(id, {
          album: { name: 'Album', release_date: revision ? '2010-01-01' : '2020-01-01', images: [] },
        })))));
        await deliver({ generation, revision }, testEnv);
      }
      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation='old-public' AND recording_key='isrc:USABC2100001'").first()).toEqual({ spotify_id: trackId22(31) });
      expect(await env.DB.prepare("SELECT spotify_id FROM recordings WHERE generation=? AND recording_key='isrc:USABC2100001'").bind(generation).first()).toEqual({ spotify_id: trackId22(32) });
      expect((await statusSnapshot(env)).progress.publishedRecordings).toBe(1);
    });

    it('publishes at most thirty validated recordings per waiting delivery without Spotify calls or cursor changes', async () => {
      const generation = 'waiting-publication';
      const testEnv = await publicationFixture(generation);
      for (let i = 1; i <= 50; i++) await stageRecording(generation, `waiting-${i}`, trackId22(i + 100), otherArtistId);
      await env.DB.prepare("UPDATE rebuild_jobs SET retry_at=?,next_read_at=?,wait_reason='quota',retry_source='spotify',quota_attempts=2 WHERE generation=?")
        .bind(Date.now() + 86400000, Date.now() + 100000, generation).run();
      await env.DB.prepare("UPDATE rebuild_seed_artists SET status='pending',cursor='next-release-page'").run();
      const before = await jobRow(generation);
      const fetchSpy = vi.fn(() => { throw new Error('No HTTP during a provider wait'); });
      vi.stubGlobal('fetch', fetchSpy);
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(31);
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(52);
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).progress).toMatchObject({ publishedRecordings: 51, publishedArtists: 1 });
      expect(await jobRow(generation)).toEqual(before);
      expect(await env.DB.prepare('SELECT status,cursor FROM rebuild_seed_artists').first()).toEqual({ status: 'pending', cursor: 'next-release-page' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('publishes waiting artists with interleaved recording keys without skipping or rescanning earlier artists', async () => {
      const generation = 'waiting-artist-order';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare('DELETE FROM recordings WHERE generation=?').bind(generation).run();
      for (const [key, bucket, id] of [['b', trackId22(999), 31], ['y', trackId22(999), 32], ['a', otherArtistId, 33], ['z', otherArtistId, 34]] as const) {
        await stageRecording(generation, key, trackId22(id), bucket);
      }
      await env.DB.prepare('UPDATE rebuild_jobs SET retry_at=?').bind(Date.now() + 86400000).run();
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No Spotify calls while waiting'); }));
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(3);
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(5);
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).progress).toMatchObject({ publishedRecordings: 4, publishedArtists: 2 });
    });

    it('remembers an exhausted waiting pass so duplicate cooldown wakes do not rescan the catalogue', async () => {
      const generation = 'waiting-empty-pass';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare('UPDATE rebuild_jobs SET retry_at=?').bind(Date.now() + 86400000).run();
      const scans = vi.fn();
      const database = new Proxy(testEnv.DB, { get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          if (sql.includes('FROM refresh_state s JOIN recordings r')) scans();
          return target.prepare(sql);
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No Spotify calls while waiting'); }));
      const before = await jobRow(generation);
      for (let index = 0; index < 5; index++) await deliver({ generation, revision: 0 }, { ...testEnv, DB: database });
      expect(scans).toHaveBeenCalledTimes(2); // One publication, one empty pass, then singleton-only wakes.
      expect((await statusSnapshot(env)).candidateCount).toBe(2);
      expect(await jobRow(generation)).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('restarts an exhausted waiting scan after a source revision adds an earlier artist or key', async () => {
      const generation = 'waiting-new-revision';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare('UPDATE rebuild_jobs SET retry_at=?').bind(Date.now() + 86400000).run();
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No Spotify calls while waiting'); }));
      await deliver({ generation, revision: 0 }, testEnv);
      await deliver({ generation, revision: 0 }, testEnv);
      await stageRecording(generation, 'a-new-earlier-key', trackId22(77), '0000000000000000000000');
      await env.DB.prepare('UPDATE rebuild_jobs SET revision=revision+1').run();
      await deliver({ generation, revision: 1 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(3);
      expect(await env.DB.prepare("SELECT recording_key FROM recordings WHERE generation='old-public' AND recording_key='a-new-earlier-key'").first())
        .toEqual({ recording_key: 'a-new-earlier-key' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not cache an empty waiting pass while another invocation holds the lease', async () => {
      const generation = 'waiting-empty-lease';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare('DELETE FROM recordings WHERE generation=?').bind(generation).run();
      await env.DB.prepare('UPDATE rebuild_jobs SET retry_at=?,lease_until=?').bind(Date.now() + 86400000, Date.now() + 100000).run();
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No Spotify calls while waiting'); }));
      await deliver({ generation, revision: 0 }, testEnv);
      await stageRecording(generation, 'after-lease', trackId22(78));
      await env.DB.prepare('UPDATE rebuild_jobs SET lease_until=NULL').run();
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(2);
    });

    it('does not save an exhausted waiting pass onto a migration-rerouted revision', async () => {
      const generation = 'waiting-empty-revision-race';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare('DELETE FROM recordings WHERE generation=?').bind(generation).run();
      await env.DB.prepare('UPDATE rebuild_jobs SET retry_at=?').bind(Date.now() + 86400000).run();
      await deliver({ generation, revision: 0 }, raceBeforeBatch(testEnv, 1, () => rerouteForMigration(generation)));
      const progress = (await env.DB.prepare('SELECT progress_json FROM rebuild_jobs').first<{ progress_json: string }>())!;
      expect(JSON.parse(progress.progress_json).publicationScan).toBeUndefined();
      expect(await jobRow(generation)).toMatchObject({ revision: 1, phase: 'never_identities', lease_until: null });
    });

    it.each(['preflight', 'never_identities', 'seeds', 'known_playlists', 'known_playlist_items'] as RefreshPhase[])
      ('does not publish staging during a wait before exclusions are frozen (%s)', async phase => {
        const generation = `unsafe-wait-${phase}`;
        const testEnv = await publicationFixture(generation);
        await env.DB.prepare('UPDATE rebuild_jobs SET phase=?,retry_at=?').bind(phase, Date.now() + 86400000).run();
        vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No HTTP while waiting'); }));
        await deliver({ generation, revision: 0 }, testEnv);
        expect((await statusSnapshot(env)).candidateCount).toBe(1);
      });

    it('does not publish waiting staging while another invocation holds the lease', async () => {
      const generation = 'waiting-lease';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare('UPDATE rebuild_jobs SET retry_at=?,lease_until=?').bind(Date.now() + 86400000, Date.now() + 100000).run();
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(1);
    });

    it('revision-guards waiting publication against a migration or replacement job', async () => {
      const generation = 'waiting-revision-race';
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare('UPDATE rebuild_jobs SET retry_at=?').bind(Date.now() + 86400000).run();
      await deliver({ generation, revision: 0 }, raceBeforeBatch(testEnv, 1, () => rerouteForMigration(generation)));
      expect((await statusSnapshot(env)).candidateCount).toBe(1);
      expect(await env.DB.prepare('SELECT count(*) AS count FROM refresh_publications').first()).toEqual({ count: 0 });
    });

    it.each(['scan', 'alias'])('keeps later known exclusions authoritative for early public copies (%s)', async kind => {
      const generation = `published-known-${kind}`;
      const testEnv = await publicationFixture(generation);
      await env.DB.prepare("UPDATE recordings SET recording_key='isrc:USABC2100001',isrc='USABC2100001' WHERE generation=?").bind(generation).run();
      await deliver({ generation, revision: 0 }, testEnv);
      const guard = { generation, revision: 1, phase: 'artist_albums' };
      if (kind === 'scan') await env.DB.batch(knownTrackStatements(testEnv, guard, [{ id: trackId22(2), key: 'isrc:USABC2100001' }]));
      else {
        await env.DB.batch(knownTrackStatements(testEnv, guard, [{ id: trackId22(3), key: `spotify:${trackId22(3)}` }]));
        await env.DB.batch(knownIdentityStatements(testEnv, guard, [{ spotifyId: trackId22(3), isrc: 'USABC2100001' }]));
      }
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_known_recordings WHERE generation='old-public' AND recording_key='isrc:USABC2100001'").first()).toEqual({ count: 1 });
      // A disjoint final rebuild must retain the copied exclusion even when
      // quarantine removes the private generation's known overlay.
      await stageRecording(generation, 'replacement-only', trackId22(4), otherArtistId);
      await env.DB.prepare("UPDATE rebuild_jobs SET phase='promote',next_read_at=0").run();
      await deliver({ generation, revision: 1 }, testEnv);
      expect((await statusSnapshot(env)).latestOutcome).toBe('quarantined');
      const response = await worker.fetch(new Request(`${testEnv.APP_ORIGIN}/api/recommendation?exclude=${trackId22(1)}`), testEnv);
      expect(response.status).toBe(200);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM recommendation_slots WHERE generation='old-public' AND recording_key='isrc:USABC2100001'").first()).toEqual({ count: 0 });
    });

    it('filters an owner exclusion that commits immediately before publication', async () => {
      const generation = 'publication-owner-race';
      const testEnv = await publicationFixture(generation);
      const raced = raceBeforeBatch(testEnv, 1, async () => {
        await env.DB.prepare("INSERT INTO never_recordings(recording_key,spotify_id,excluded_at) VALUES ('new',?,1)").bind(trackId22(2)).run();
      });
      await deliver({ generation, revision: 0 }, raced);
      expect((await statusSnapshot(env)).candidateCount).toBe(1);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM refresh_publications").first()).toEqual({ count: 0 });
    });

    it('does not copy, publish or complete stale work after a migration reroutes it', async () => {
      const generation = 'publication-revision-race';
      const testEnv = await publicationFixture(generation);
      await deliver({ generation, revision: 0 }, raceBeforeBatch(testEnv, 1, () => rerouteForMigration(generation)));
      expect((await statusSnapshot(env)).candidateCount).toBe(1);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM refresh_publications").first()).toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_seed_artists WHERE generation=?").bind(generation).first()).toEqual({ count: 1 });
    });

    it.each(['completion', 'waiting'])('rolls back publication, counters and work together if the transaction fails (%s)', async kind => {
      const generation = `publication-rollback-${kind}`;
      const testEnv = await publicationFixture(generation);
      if (kind === 'waiting') await env.DB.prepare('UPDATE rebuild_jobs SET retry_at=?').bind(Date.now() + 86400000).run();
      let fail = true;
      const database = new Proxy(testEnv.DB, { get(target, key) {
        if (key === 'batch') return async (items: D1PreparedStatement[]) => {
          if (fail) {
            fail = false;
            return target.batch([...items, target.prepare('SELECT * FROM missing_publication_fixture')]);
          }
          return target.batch(items);
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      await deliver({ generation, revision: 0 }, { ...testEnv, DB: database });
      expect((await statusSnapshot(env)).candidateCount).toBe(1);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM refresh_publications").first()).toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM recordings WHERE generation='old-public'").first()).toEqual({ count: 1 });
      expect(await env.DB.prepare('SELECT count(*) AS count FROM rebuild_seed_artists WHERE generation=?').bind(generation).first()).toEqual({ count: 1 });
      expect((await jobRow(generation))?.phase).toBe('enrich');
      expect(JSON.parse((await env.DB.prepare('SELECT progress_json FROM rebuild_jobs').first<{ progress_json: string }>())!.progress_json).publicationAfterArtist).toBeUndefined();
    });

    it.each([0, 2])('keeps original promotion gates and discovery yield after adding five recordings (overlap %i)', async (overlap) => {
      const generation = `publication-gate-${overlap}`;
      const testEnv = await publicationFixture(generation);
      for (let i=2; i<=4; i++) await stageRecording('old-public', `old-${i}`, trackId22(i+10));
      for (let i=2; i<=5; i++) await stageRecording(generation, `new-${i}`, trackId22(i+20), otherArtistId);
      if (overlap) {
        await stageRecording(generation, 'old', trackId22(1));
        await stageRecording(generation, 'old-2', trackId22(12));
      }
      await rebuildRecommendationPool(env, 'old-public');
      await env.DB.prepare("UPDATE refresh_state SET candidate_count=(SELECT count(*) FROM recommendation_slots WHERE generation='old-public'),live_bucket_count=(SELECT count(*) FROM recommendation_buckets WHERE generation='old-public') WHERE singleton=1").run();
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).candidateCount).toBe(9);
      await env.DB.prepare("UPDATE rebuild_jobs SET phase='promote',next_read_at=0 WHERE generation=?").bind(generation).run();
      await deliver({ generation, revision: 1 }, testEnv);
      const snapshot = await statusSnapshot(env);
      expect(snapshot.latestOutcome).toBe(overlap ? 'promoted' : 'quarantined');
      expect(snapshot.progress.newRecordings).toBe(5);
      expect(snapshot.candidateCount).toBe(overlap ? 7 : 9);
    });

    it('processes tracks after admitting eight artists and prioritises artists absent from the live shelf', async () => {
      const generation = 'bounded-artists';
      await stageRecording('old-public', 'old', trackId22(90), trackId22(1));
      await setLive('old-public'); await rebuildRecommendationPool(env, 'old-public');
      await env.DB.prepare("UPDATE refresh_state SET candidate_count=(SELECT count(*) FROM recommendation_slots WHERE generation='old-public'),live_bucket_count=(SELECT count(*) FROM recommendation_buckets WHERE generation='old-public') WHERE singleton=1").run();
      await seedJob(generation, 'artist_albums', { fairScheduler: 1 });
      for (let i=1;i<=16;i++) await env.DB.prepare('INSERT INTO rebuild_seed_artists(generation,spotify_id) VALUES (?,?)').bind(generation,trackId22(i)).run();
      const urls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url=String(input); urls.push(url);
        if (url.includes('/api/token')) return tokenResponse(SERVICE_SCOPES, 3600);
        if (url.includes('/v1/artists/')) return pageResponse([{ id: trackId22(100+urls.length), name: 'Album', images: [] }]);
        if (url.includes('/v1/albums/')) return pageResponse([]);
        throw new Error(`Unexpected request ${url}`);
      }));
      const {testEnv}=queueEnv();
      for (let i=0;i<9;i++) {
        const job=(await jobRow(generation))!; await elapsePacing(generation);
        await deliver({generation,revision:job.revision},testEnv);
      }
      expect(urls.filter(url=>url.includes('/v1/artists/'))).toHaveLength(8);
      expect(urls.some(url=>url.includes(`/v1/artists/${trackId22(1)}/`))).toBe(false);
      expect(urls.some(url=>url.includes('/v1/albums/'))).toBe(true);
      expect(await env.DB.prepare('SELECT count(*) AS count FROM rebuild_seed_artists WHERE admitted=1').first()).toEqual({count:8});
    });

    it('admits an already-started missing artist before spending quota discovering untouched artists', async () => {
      const generation = 'queued-releases-first';
      await stageRecording('old-public', 'old', trackId22(90));
      await setLive('old-public');
      await rebuildRecommendationPool(env, 'old-public');
      await seedJob(generation, 'artist_albums', { fairScheduler: 1 });
      for (let i = 1; i <= 16; i++) await env.DB.prepare('INSERT INTO rebuild_seed_artists(generation,spotify_id,turns) VALUES (?,?,?)')
        .bind(generation, trackId22(i), i === 15 ? 1 : 0).run();
      await env.DB.prepare("INSERT INTO rebuild_album_queue(generation,spotify_id,bucket_artist_id,album_name) VALUES (?,?,?,'Queued album')")
        .bind(generation, trackId22(100), trackId22(15)).run();
      const urls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input); urls.push(url);
        if (url.includes('/api/token')) return tokenResponse();
        if (url.includes('/v1/albums/')) return pageResponse([]);
        throw new Error('Discovery must not run ahead of queued releases');
      }));
      await deliver({ generation, revision: 0 }, queueEnv().testEnv);
      expect(urls.filter(url => url.includes('/v1/albums/'))).toHaveLength(1);
      expect(urls.some(url => url.includes('/v1/artists/'))).toBe(false);
      expect(await env.DB.prepare('SELECT spotify_id FROM rebuild_seed_artists WHERE admitted=1').first()).toEqual({ spotify_id: trackId22(15) });
    });

    it.each([2, 8])('uses queued work after a quota wait before retrying a cold release list (%i admitted)', async admitted => {
      const generation = `quota-backlog-${admitted}`;
      await seedJob(generation, 'artist_albums', { fairScheduler: 1, workKey: trackId22(1) });
      await env.DB.prepare("UPDATE rebuild_jobs SET quota_attempts=1,quota_endpoint='artistAlbums'").run();
      for (let i = 1; i <= 10; i++) await env.DB.prepare('INSERT INTO rebuild_seed_artists(generation,spotify_id,admitted,turns) VALUES (?,?,?,?)')
        .bind(generation, trackId22(i), i <= admitted ? 1 : 0, i === 2 ? 2 : 0).run();
      await env.DB.prepare("INSERT INTO rebuild_album_queue(generation,spotify_id,bucket_artist_id,album_name) VALUES (?,?,?,'Queued album')")
        .bind(generation, trackId22(100), trackId22(2)).run();
      const urls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input); urls.push(url);
        if (url.includes('/api/token')) return tokenResponse();
        if (url.includes('/v1/albums/')) return pageResponse([]);
        throw new Error('Must process queued work before retrying release discovery');
      }));
      await deliver({ generation, revision: 0 }, queueEnv().testEnv);
      expect(urls.filter(url => url.includes('/v1/albums/'))).toHaveLength(1);
      expect(urls.some(url => url.includes('/v1/artists/'))).toBe(false);
      expect(await env.DB.prepare('SELECT count(*) AS count FROM rebuild_album_queue').first()).toEqual({ count: 0 });
    });
  });

  describe("promotion gates", () => {
    const liveWith = async (keys: string[]) => {
      for (const [index, key] of keys.entries()) await stageRecording("live-1", key, trackId22(index + 1));
      await env.DB.prepare("INSERT INTO recording_generations (generation, promoted_at) VALUES ('live-1', 1)").run();
      await setLive("live-1");
    };

    it("never promotes an empty generation over a live shelf", async () => {
      await liveWith(["k1", "k2"]);
      const generation = "empty-stage";
      await seedJob(generation, "promote");
      const { testEnv } = queueEnv();
      const result = await deliver({ generation, revision: 0 }, testEnv);
      expect(result.explicitAcks).toHaveLength(1);
      const state = await env.DB.prepare("SELECT live_generation, last_outcome, pending_low FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null; last_outcome: string | null; pending_low: number }>();
      expect(state).toMatchObject({ live_generation: "live-1", last_outcome: "empty", pending_low: 0 });
      expect(await jobRow(generation)).toBeNull();
    });

    it("promotes a nonempty generation when nothing is live yet, atomically and with retention", async () => {
      const generation = "first-promotion";
      await stageRecording(generation, "k1", trackId22(1));
      await stageRecording(generation, "k2", trackId22(2), otherArtistId);
      await seedJob(generation, "promote");
      const { testEnv } = queueEnv();
      await deliver({ generation, revision: 0 }, testEnv);
      const state = await env.DB.prepare("SELECT live_generation, candidate_count, last_outcome, refreshed_at FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null; candidate_count: number; last_outcome: string | null; refreshed_at: number | null }>();
      expect(state).toMatchObject({ live_generation: generation, candidate_count: 2, last_outcome: "promoted" });
      expect(state!.refreshed_at).toBeGreaterThan(0);
      expect(await env.DB.prepare("SELECT generation FROM recording_generations WHERE generation = ?").bind(generation).first()).toBeTruthy();
      expect(await jobRow(generation)).toBeNull();
      const snapshot = await statusSnapshot(env);
      expect(snapshot).toMatchObject({ state: "idle", candidateCount: 2 });
    });

    it("does not promote or delete a rerouted job after a migration invalidates the delivery revision", async () => {
      const generation = "promotion-migration-race";
      await stageRecording(generation, "k1", trackId22(1));
      await seedJob(generation, "promote");
      const { testEnv } = queueEnv();
      const racedEnv = raceBeforeBatch(testEnv, 1, () => rerouteForMigration(generation));

      await deliver({ generation, revision: 0 }, racedEnv);

      expect(await env.DB.prepare("SELECT live_generation, candidate_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ live_generation: null, candidate_count: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recording_generations WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 0 });
      expect(await jobRow(generation)).toMatchObject({ phase: "never_identities", revision: 1, dispatch_pending: 0 });
    });

    it("finalizes an already-registered bootstrap generation idempotently", async () => {
      const generation = "bootstrap-final";
      await stageRecording(generation, "k1", trackId22(1));
      await env.DB.prepare("INSERT INTO recording_generations (generation, promoted_at) VALUES (?, 1)").bind(generation).run();
      await setLive(generation);
      await seedJob(generation, "promote");
      const { testEnv } = queueEnv();
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await jobRow(generation)).toBeNull();
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recording_generations WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 1 });
      expect(await env.DB.prepare("SELECT live_generation, last_outcome FROM refresh_state WHERE singleton = 1").first<{ live_generation: string; last_outcome: string }>()).toMatchObject({ live_generation: generation, last_outcome: "promoted" });
    });

    it("promotes at or above half overlap and clears a pending-low flag", async () => {
      await liveWith(["k1", "k2", "k3", "k4"]);
      await env.DB.prepare("UPDATE refresh_state SET pending_low = 1 WHERE singleton = 1").run();
      const generation = "similar-stage";
      await stageRecording(generation, "k1", trackId22(1));
      await stageRecording(generation, "k2", trackId22(2));
      await seedJob(generation, "promote");
      const { testEnv } = queueEnv();
      await deliver({ generation, revision: 0 }, testEnv);
      const state = await env.DB.prepare("SELECT live_generation, pending_low, last_outcome FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null; pending_low: number; last_outcome: string | null }>();
      expect(state).toMatchObject({ live_generation: generation, pending_low: 0, last_outcome: "promoted" });
      // The replaced shelf is retained indefinitely.
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recordings WHERE generation = 'live-1'").first<{ count: number }>()).toMatchObject({ count: 4 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recording_generations").first<{ count: number }>()).toMatchObject({ count: 2 });
    });

    it("quarantines the first completed nonempty miss below the floor", async () => {
      await liveWith(["k1", "k2", "k3", "k4"]);
      const generation = "quarantine-stage";
      await stageRecording(generation, "k1", trackId22(1));
      await seedJob(generation, "promote");
      const { testEnv } = queueEnv();
      await deliver({ generation, revision: 0 }, testEnv);
      const state = await env.DB.prepare("SELECT live_generation, pending_low, last_outcome FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null; pending_low: number; last_outcome: string | null }>();
      expect(state).toMatchObject({ live_generation: "live-1", pending_low: 1, last_outcome: "quarantined" });
      expect(await jobRow(generation)).toBeNull();
    });

    it("promotes the next completed nonempty miss regardless of similarity", async () => {
      await liveWith(["k1", "k2", "k3", "k4"]);
      await env.DB.prepare("UPDATE refresh_state SET pending_low = 1 WHERE singleton = 1").run();
      const generation = "second-miss-stage";
      await stageRecording(generation, "k1", trackId22(1));
      await seedJob(generation, "promote");
      const { testEnv } = queueEnv();
      await deliver({ generation, revision: 0 }, testEnv);
      const state = await env.DB.prepare("SELECT live_generation, pending_low, last_outcome FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null; pending_low: number; last_outcome: string | null }>();
      expect(state).toMatchObject({ live_generation: generation, pending_low: 0, last_outcome: "promoted" });
    });

    it("neither clears nor confirms pending-low when the rebuild fails", async () => {
      await liveWith(["k1", "k2"]);
      await env.DB.prepare("UPDATE refresh_state SET pending_low = 1 WHERE singleton = 1").run();
      const generation = "failing-stage";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 400)));
      await deliver({ generation, revision: 0 }, testEnv);
      const state = await env.DB.prepare("SELECT pending_low, last_outcome, live_generation FROM refresh_state WHERE singleton = 1").first<{ pending_low: number; last_outcome: string | null; live_generation: string | null }>();
      expect(state).toMatchObject({ pending_low: 1, last_outcome: "failed", live_generation: "live-1" });
      // The failed job stays visible for the next scheduled tick to replace.
      expect(await jobRow(generation)).toMatchObject({ status: "failed" });
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("persistent progress and request accounting", () => {
    it("counts unique seed artists and saved pages once across duplicate deliveries", async () => {
      const generation = "progress-seeds";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv } = queueEnv();
      const next = `${LIKED_URL}&offset=50`;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { track: { id: trackId, artists: [{ id: artistId }] } },
        { track: { id: trackId22(2), artists: [{ id: artistId }] } },
      ], next)));
      await deliver({ generation, revision: 0 }, testEnv);
      const first = await statusSnapshot(env);
      expect(first.progress).toMatchObject({ seedArtists: 1, likedTracksScanned: 2 });
      expect(first.requests).toMatchObject({ token: { attempts: 1, succeeded: 1 }, likedTracks: { attempts: 1, succeeded: 1 } });
      expect(first.requestCountBasis).toBe("observed");
      vi.stubGlobal("fetch", vi.fn());
      await deliver({ generation, revision: 0 }, testEnv);
      expect(fetch).not.toHaveBeenCalled();
      expect((await statusSnapshot(env)).progress).toEqual(first.progress);
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([
        { track: { id: trackId22(3), artists: [{ id: artistId }] } },
        { track: { id: trackId22(4), artists: [{ id: otherArtistId }] } },
      ])));
      await deliver({ generation, revision: 1 }, testEnv);
      expect((await statusSnapshot(env)).progress).toMatchObject({ seedArtists: 2, likedTracksScanned: 4, seedScanComplete: 1 });
      expect((await statusSnapshot(env)).requests.likedTracks).toMatchObject({ attempts: 2, succeeded: 2, failed: 0 });
    });

    it("rolls back counters with the source cursor when a transaction fails", async () => {
      const generation = "progress-rollback";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv } = queueEnv();
      let once = true;
      const database = new Proxy(testEnv.DB, { get(target, property) {
        if (property === 'batch') return async (batch: D1PreparedStatement[]) => {
          if (once) { once = false; return target.batch([...batch, target.prepare('INSERT INTO missing_table VALUES (1)')]); }
          return target.batch(batch);
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ track: { id: trackId, artists: [{ id: artistId }] } }])));
      await deliver({ generation, revision: 0 }, { ...testEnv, DB: database });
      expect((await statusSnapshot(env)).progress).toEqual({});
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_seed_artists").first()).toEqual({ count: 0 });
      expect((await statusSnapshot(env)).requests.likedTracks).toMatchObject({ attempts: 1, succeeded: 1 });
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ track: { id: trackId, artists: [{ id: artistId }] } }])));
      await deliver({ generation, revision: 1 }, testEnv);
      expect((await statusSnapshot(env)).progress).toMatchObject({ seedArtists: 1, likedTracksScanned: 1 });
      expect((await statusSnapshot(env)).requests.likedTracks).toMatchObject({ attempts: 2, succeeded: 2 });
    });

    it("rejects stale counters and seed insertion when the job is rerouted", async () => {
      const generation = "progress-reroute";
      await seedJob(generation, "seeds", { cursor: LIKED_URL });
      const { testEnv } = queueEnv();
      const racedEnv = raceBeforeBatch(testEnv, 1, () => rerouteForMigration(generation));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ track: { id: trackId, artists: [{ id: artistId }] } }])));
      await deliver({ generation, revision: 0 }, racedEnv);
      expect((await statusSnapshot(env)).progress).toEqual({});
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_seed_artists").first()).toEqual({ count: 0 });
      // The HTTP request really happened, so retain its observation.
      expect((await statusSnapshot(env)).requests.likedTracks).toMatchObject({ attempts: 1 });
    });

    it("counts artist completion only when saved remaining work is finished", async () => {
      const generation = "progress-artist";
      await seedJob(generation, "enrich", { workKey: artistId });
      await env.DB.prepare("UPDATE rebuild_jobs SET progress_json = '{\"seedArtists\":1,\"seedScanComplete\":1}'").run();
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES (?, ?, 'catalogued')").bind(generation, artistId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn());
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).progress.seedArtistsDone).toBe(1);
      await deliver({ generation, revision: 0 }, testEnv);
      await deliver({ generation, revision: 1 }, testEnv);
      expect((await statusSnapshot(env)).progress.seedArtistsDone).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("keeps partial metadata counters while waiting, then counts a cache hit once", async () => {
      const generation = "progress-partial";
      const ids = [trackId22(71), trackId22(72), trackId22(73)];
      await seedJob(generation, "enrich", { market: "GR", workKey: artistId });
      await env.DB.prepare("UPDATE rebuild_jobs SET progress_json = '{\"tracksDiscovered\":3}'").run();
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify(ids)).run();
      await env.DB.prepare("INSERT INTO spotify_track_cache VALUES (?, 'GR', ?, ?, ?)").bind(env.OWNER_SPOTIFY_ID, ids[0], JSON.stringify(fullTrack(ids[0]!)), Date.now() + 60000).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(ids[1]!, { external_ids: { isrc: 'USABC2100072' } })))).mockResolvedValueOnce(quotaResponse(60)));
      await deliver({ generation, revision: 0 }, testEnv);
      const paused = await statusSnapshot(env);
      expect(paused).toMatchObject({ state: 'waiting', retrySource: 'spotify', progress: { tracksDiscovered: 3, tracksProcessed: 2, tracksCached: 1, tracksFetched: 1, stagedRecordings: 2 } });
      expect(paused.requests.tracks).toMatchObject({ attempts: 2, succeeded: 1, failed: 1, rateLimited: 1 });
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).progress).toEqual(paused.progress);
      await elapsePacing(generation);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(JSON.stringify(fullTrack(ids[2]!, { external_ids: { isrc: 'USABC2100073' } })))));
      await deliver({ generation, revision: 1 }, testEnv);
      const resumed = await statusSnapshot(env);
      expect(resumed.progress).toMatchObject({ tracksProcessed: 3, tracksCached: 1, tracksFetched: 2, stagedRecordings: 3 });
      expect(resumed.requests.tracks).toMatchObject({ attempts: 3, succeeded: 2, failed: 1 });
      expect(resumed.quotaRecoveryAt).toBeGreaterThan(0);
      expect(await env.DB.prepare("SELECT quota_attempts FROM rebuild_jobs").first()).toEqual({ quota_attempts: 0 });
    });

    it("counts album checks and known skips with their queue checkpoint", async () => {
      const generation = "progress-known";
      await seedJob(generation, "album_tracks", { market: "GR", workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name) VALUES (?, ?, ?, 'Album')").bind(generation, albumId, artistId).run();
      await env.DB.prepare("INSERT INTO rebuild_known_tracks VALUES (?, ?, 'isrc:USABC2100001')").bind(generation, trackId).run();
      const { testEnv } = queueEnv();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([{ id: trackId }, { id: trackId22(9) }, { id: trackId22(9) }])));
      await deliver({ generation, revision: 0 }, testEnv);
      expect((await statusSnapshot(env)).progress).toMatchObject({ tracksDiscovered: 2, tracksProcessed: 1, tracksKnown: 1 });
      expect((await statusSnapshot(env)).requests.albumTracks).toMatchObject({ attempts: 1 });
    });

    it("retains the latest progress after promotion and clears it for a new run", async () => {
      const generation = "progress-finished";
      await seedJob(generation, "promote");
      await stageRecording(generation, 'isrc:USABC2100001', trackId);
      await env.DB.prepare("UPDATE rebuild_jobs SET progress_json = '{\"seedArtists\":2,\"seedArtistsDone\":2,\"tracksProcessed\":8}', request_counts_json = '{\"tracks\":{\"attempts\":8,\"succeeded\":8,\"failed\":0,\"rateLimited\":0,\"lastAttemptAt\":1,\"lastSuccessAt\":1}}', progress_started_at = 123, progress_partial = 1").run();
      const { testEnv } = queueEnv();
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await statusSnapshot(env)).toMatchObject({ state: 'idle', progress: { seedArtistsDone: 2, tracksProcessed: 8 }, progressPartial: true, progressSinceAt: 123, requests: { tracks: { attempts: 8 } } });
      const next = await startOrWakeRebuild(testEnv);
      expect(next.progress).toEqual({});
      expect(next.requests).toEqual({});
      expect(next.progressPartial).toBe(false);
      expect(next.progressSinceAt).toBeGreaterThan(123);
    });

    it("polls only the two singleton rows regardless of work volume", async () => {
      await seedJob('progress-cheap', 'enrich');
      const prepare = vi.fn((query: string) => env.DB.prepare(query));
      await statusSnapshot({ ...env, DB: new Proxy(env.DB, { get(target, key) {
        if (key === 'prepare') return prepare;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      } }) });
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(prepare.mock.calls.map(([query]) => query).join(' ')).not.toMatch(/COUNT\(|rebuild_enrich_queue|recordings WHERE/);
    });
  });

  describe("quota retry policy", () => {
    it("does not infer quota recovery from a different endpoint", async () => {
      const generation = 'quota-other-endpoint';
      await seedJob(generation, 'known_liked', { cursor: LIKED_URL });
      await env.DB.prepare("UPDATE rebuild_jobs SET quota_attempts = 2, quota_endpoint = 'tracks', quota_wait_started_at = 1").run();
      const { testEnv } = queueEnv();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([])));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(await env.DB.prepare("SELECT quota_attempts, quota_endpoint, quota_last_recovery_at FROM rebuild_jobs").first()).toEqual({ quota_attempts: 2, quota_endpoint: 'tracks', quota_last_recovery_at: null });
    });

    it("honors upstream Retry-After and records failed HTTP attempts", async () => {
      const generation = 'upstream-provider';
      await seedJob(generation, 'seeds', { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 503, { 'Retry-After': '300' })));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: 'json', delaySeconds: 300 });
      expect(await statusSnapshot(env)).toMatchObject({ state: 'waiting', waitReason: 'upstream', retrySource: 'spotify', requests: { likedTracks: { attempts: 1, failed: 1, rateLimited: 0 } } });
    });

    it("uses a short provider Retry-After instead of imposing a day", async () => {
      const generation = 'quota-provider';
      await seedJob(generation, 'seeds', { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(quotaResponse(120)));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: 'json', delaySeconds: 120 });
      expect(await statusSnapshot(env)).toMatchObject({ state: 'waiting', retrySource: 'spotify', waitReason: 'quota' });
    });

    it("increases missing-header probe intervals and caps them at six hours", async () => {
      const generation = 'quota-growing';
      await seedJob(generation, 'seeds', { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      for (const [revision, seconds] of [900, 1800, 3600, 7200, 14400, 21600, 21600].entries()) {
        await elapsePacing(generation);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(quotaResponse()));
        await deliver({ generation, revision }, testEnv);
        expect(send).toHaveBeenLastCalledWith({ generation, revision: revision + 1 }, { contentType: 'json', delaySeconds: seconds });
        expect(await statusSnapshot(env)).toMatchObject({ retrySource: 'backoff', requests: { likedTracks: { attempts: revision + 1, rateLimited: revision + 1 } } });
      }
    });

    it.each(['bad', '-1', 'Infinity'])('treats invalid Retry-After %s as missing', async (header) => {
      const generation = 'quota-bad-header';
      await seedJob(generation, 'seeds', { cursor: LIKED_URL });
      const { testEnv, send } = queueEnv();
      const response = quotaResponse(); response.headers.set('Retry-After', header);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(response));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: 'json', delaySeconds: 900 });
      expect((await statusSnapshot(env)).retrySource).toBe('backoff');
    });

    it("keeps a longer rolling wait when another concurrent response reports quota", async () => {
      const generation = 'quota-mixed';
      await seedJob(generation, 'enrich', { workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([trackId22(93), trackId22(94)])).run();
      const { testEnv, send } = queueEnv();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(pageResponse([], null, 429, { 'Retry-After': '3600' })).mockResolvedValueOnce(quotaResponse(30)));
      await deliver({ generation, revision: 0 }, testEnv);
      expect(send).toHaveBeenLastCalledWith({ generation, revision: 1 }, { contentType: 'json', delaySeconds: 3600 });
      expect(await statusSnapshot(env)).toMatchObject({ state: 'waiting', waitReason: 'quota', retrySource: 'spotify' });
    });

    it("understands an HTTP-date and preserves the longest concurrent wait", async () => {
      const generation = 'quota-longest';
      await seedJob(generation, 'enrich', { workKey: artistId });
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([trackId22(91), trackId22(92)])).run();
      const { testEnv, send } = queueEnv();
      const long = quotaResponse(); long.headers.set('Retry-After', new Date(Date.now() + 3600000).toUTCString());
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(long).mockResolvedValueOnce(quotaResponse(30)));
      await deliver({ generation, revision: 0 }, testEnv);
      const options = send.mock.calls.at(-1)![1] as { delaySeconds: number };
      expect(options.delaySeconds).toBeGreaterThan(3590);
      expect(options.delaySeconds).toBeLessThanOrEqual(3600);
      expect((await statusSnapshot(env)).retrySource).toBe('spotify');
    });
  });

  describe("refresh watchdog", () => {
    it.each(["idle", "failed", "unknown-cron"])("leaves %s work and the weekly schedule unchanged", async (state) => {
      if (state !== "idle") await seedJob("watchdog-idle", "seeds", { status: state === "failed" ? "failed" : "active" });
      const before = await statusSnapshot(env);
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn());
      await tick(testEnv, Date.now(), state === "unknown-cron" ? "* * * * *" : WATCHDOG_CRON_EXPRESSION);
      expect(send).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(await statusSnapshot(env)).toEqual(before);
    });

    it.each(["recent", "lease", "retry", "pacing"])("preserves the %s gate", async (gate) => {
      await seedJob("watchdog-gate", "seeds", { cursor: LIKED_URL, revision: 4 });
      const field = { recent: "updated_at", lease: "lease_until", retry: "retry_at", pacing: "next_read_at" }[gate]!;
      // The grace also covers a gate that has just expired, allowing its normal
      // queued delivery to run before the watchdog introduces a duplicate.
      const { testEnv, send } = queueEnv();
      for (const offset of [-30_000, 60_000]) {
        await env.DB.prepare(`UPDATE rebuild_jobs SET ${field} = ?`).bind(Date.now() + offset).run();
        const before = await jobRow("watchdog-gate");
        await tick(testEnv, Date.now(), WATCHDOG_CRON_EXPRESSION);
        expect(send).not.toHaveBeenCalled();
        expect(await jobRow("watchdog-gate")).toEqual(before);
      }
    });

    it("requeues overdue work without changing its generation, cursor, revision or weekly schedule", async () => {
      await seedJob("watchdog-overdue", "seeds", { cursor: LIKED_URL, revision: 7, retryAt: 1, nextReadAt: 1 });
      await env.DB.prepare("UPDATE rebuild_jobs SET lease_until = 1").run();
      const before = await jobRow("watchdog-overdue");
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn());
      await tick(testEnv, Date.now(), WATCHDOG_CRON_EXPRESSION);
      expect(send).toHaveBeenCalledExactlyOnceWith({ generation: "watchdog-overdue", revision: 7 }, { contentType: "json" });
      expect(await jobRow("watchdog-overdue")).toEqual(before);
      expect((await statusSnapshot(env)).nextRefreshAt).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("can recover on a later tick if its own dispatch fails", async () => {
      await seedJob("watchdog-dispatch", "seeds", { revision: 2 });
      const { testEnv, send } = queueEnv();
      send.mockRejectedValueOnce(new Error("Queue unavailable"));
      await expect(tick(testEnv, Date.now(), WATCHDOG_CRON_EXPRESSION)).rejects.toThrow("Queue unavailable");
      await tick(testEnv, Date.now(), WATCHDOG_CRON_EXPRESSION);
      expect(send).toHaveBeenCalledTimes(2);
      expect(await jobRow("watchdog-dispatch")).toMatchObject({ generation: "watchdog-dispatch", revision: 2 });
    });
  });

  describe("weekly scheduled handler", () => {
    it("computes the next Sunday 03:00 UTC tick deterministically", () => {
      expect(nextWeeklyCronAt(Date.UTC(2026, 7, 19, 0, 0, 0))).toBe(Date.UTC(2026, 7, 23, 3, 0, 0));
      // Later on a Sunday itself waits a full week.
      expect(nextWeeklyCronAt(Date.UTC(2026, 7, 23, 4, 0, 0))).toBe(Date.UTC(2026, 7, 30, 3, 0, 0));
    });

    it("starts a rebuild when idle and records the next schedule", async () => {
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const scheduledTime = Date.UTC(2026, 7, 19, 3, 0, 0);
      await tick(testEnv, scheduledTime);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      const [message, options] = send.mock.calls[0] as [{ generation: string; revision: number }, { contentType: string }];
      expect(message.revision).toBe(0);
      expect(message.generation).toMatch(/^v4-/);
      expect(options).toEqual({ contentType: "json" });
      const job = await env.DB.prepare("SELECT status, phase FROM rebuild_jobs").first<{ status: string; phase: string }>();
      expect(job).toMatchObject({ status: "active", phase: "preflight" });
      expect(await env.DB.prepare("SELECT next_refresh_at FROM refresh_state WHERE singleton = 1").first<{ next_refresh_at: number | null }>()).toMatchObject({ next_refresh_at: Date.UTC(2026, 7, 23, 3, 0, 0) });
    });

    it("wakes an active cooldown without starting an overlapping rebuild", async () => {
      const generation = "cooldown-wake";
      await seedJob(generation, "seeds", { cursor: LIKED_URL, revision: 4, retryAt: Date.now() + 7_200_000 });
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      await tick(testEnv);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toEqual({ generation, revision: 4 });
      const delay = (send.mock.calls[0][1] as { delaySeconds: number }).delaySeconds;
      expect(delay).toBeGreaterThan(7_190);
      expect(delay).toBeLessThanOrEqual(7_200);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_jobs").first<{ count: number }>()).toMatchObject({ count: 1 });
    });

    it.each(["owner", "cron", "queue"])("recovers a legacy quota failure via %s without purging progress", async (wake) => {
      const generation = "legacy-quota";
      await seedJob(generation, "enrich", { market: "GR", status: "failed", workKey: artistId, revision: 9 });
      await stageRecording(generation, "saved", trackId);
      await env.DB.prepare("INSERT INTO rebuild_enrich_queue VALUES (?, 1, ?, ?)").bind(generation, artistId, JSON.stringify([trackId])).run();
      await env.DB.prepare("UPDATE refresh_state SET last_outcome = 'failed', last_error = 'track enrichment failed (429): Spotify Development Mode quota exceeded; the next scheduled rebuild will retry'").run();
      const { testEnv, send } = queueEnv();
      vi.stubGlobal("fetch", vi.fn());
      if (wake === "owner") await startOrWakeRebuild(testEnv);
      else if (wake === "cron") await tick(testEnv);
      else await deliver({ generation, revision: 9 }, testEnv);
      expect(await jobRow(generation)).toMatchObject({ status: "active", phase: "enrich", work_key: artistId, revision: 10 });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM recordings WHERE generation = ?").bind(generation).first()).toEqual({ count: 1 });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM rebuild_enrich_queue WHERE generation = ?").bind(generation).first()).toEqual({ count: 1 });
      expect(send).toHaveBeenCalledWith({ generation, revision: 10 }, { contentType: "json" });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("resumes the deployed legacy playlist 503 failure and its exact page cursor", async () => {
      const generation = "legacy-playlist-503";
      await seedJob(generation, "known_playlist_items", { status: "failed", cursor: "page-cursor", revision: 374, retryCount: 4 });
      await env.DB.prepare("INSERT INTO rebuild_playlist_queue (generation, spotify_id, cursor) VALUES (?, ?, 'playlist-page')").bind(generation, playlistId).run();
      await env.DB.prepare("UPDATE refresh_state SET last_outcome = 'failed', last_error = 'playlist items failed (503): no healthy upstream — giving up after 5 attempts'").run();
      const { testEnv, send } = queueEnv();
      await startOrWakeRebuild(testEnv);
      expect(await jobRow(generation)).toMatchObject({ status: "active", phase: "known_playlist_items", cursor: "page-cursor", revision: 375, retry_count: 0 });
      expect(await env.DB.prepare("SELECT spotify_id, cursor FROM rebuild_playlist_queue WHERE generation = ?").bind(generation).first()).toEqual({ spotify_id: playlistId, cursor: "playlist-page" });
      expect(send).toHaveBeenCalledWith({ generation, revision: 375 }, { contentType: "json" });
      expect((await statusSnapshot(env)).error).toBeUndefined();
    });

    it("replaces a systemically failed job with a fresh generation and purges its staging", async () => {
      const generation = "failed-job";
      await seedJob(generation, "enrich", { market: "GR", status: "failed" });
      await stageRecording(generation, "k1", trackId22(1));
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id) VALUES (?, ?)").bind(generation, artistId).run();
      const { testEnv, send } = queueEnv();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      await tick(testEnv);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      const newGeneration = (send.mock.calls[0][0] as { generation: string }).generation;
      expect(newGeneration).not.toBe(generation);
      expect(await jobRow(generation)).toBeNull();
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recordings WHERE generation = ?").bind(generation).first<{ count: number }>()).toMatchObject({ count: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_seed_artists WHERE generation = ?").bind(generation).first<{ count: number }>()).toMatchObject({ count: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_jobs").first<{ count: number }>()).toMatchObject({ count: 1 });
    });
  });
});

describe("shared SQL statement splitter", () => {
  it("does not leak a block comment's closing slash into the next statement", () => {
    expect(statements("CREATE TABLE a (x INTEGER); /* c ; */ SELECT 1;")).toEqual(["CREATE TABLE a (x INTEGER)", "SELECT 1"]);
    expect(statements("/* leading ; */ INSERT INTO t VALUES (1);")).toEqual(["INSERT INTO t VALUES (1)"]);
    expect(statements("SELECT 2 /* trailing */")).toEqual(["SELECT 2"]);
  });

  it("keeps ignoring semicolons inside strings and line comments", () => {
    expect(statements("INSERT INTO t VALUES ('a;b--c');")).toEqual(["INSERT INTO t VALUES ('a;b--c')"]);
    expect(statements("-- one; two\nSELECT 1")).toEqual(["SELECT 1"]);
    expect(statements("/* only ; comments */ -- nothing else\n")).toEqual([]);
  });
});
