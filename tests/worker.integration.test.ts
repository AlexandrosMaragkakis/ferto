import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
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
import wranglerConfig from "../wrangler.jsonc?raw";
import secretBindings from "../src/secret-bindings.d.ts?raw";
import generatedWorkerTypes from "../src/worker-configuration.d.ts?raw";
import viteConfig from "../vite.config.ts?raw";
import workerSource from "../src/worker.ts?raw";
import worker from "../src/worker";
import { appendRecommendationPool, rebuildRecommendationPool, removeFromRecommendationPool } from "../src/rebuild";
import { statements } from "./statements";

declare module "cloudflare:workers" { interface ProvidedEnv extends Env {} }

const trackId = "1234567890123456789012";
const otherTrackId = "abcdefghijklmnopqrstuv";
const artistId = "zyxwvutsrqponmlkjihgfe";
const origin = "http://127.0.0.1:5173";

async function hmac(value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type SeededRecording = {
  recording_key?: string;
  spotify_id?: string;
  isrc?: string | null;
  title?: string;
  bucket_artist_id?: string;
  artists?: { id: string; name: string }[];
  image_url?: string | null;
};

async function seedRecording(generation: string, seed: SeededRecording) {
  const spotifyId = seed.spotify_id ?? trackId;
  await env.DB.prepare(
    "INSERT INTO recordings (generation, recording_key, spotify_id, isrc, title, album_name, release_date, image_url, spotify_url, artists_json, bucket_artist_id) VALUES (?, ?, ?, ?, ?, 'Album', '2020-01-01', ?, ?, ?, ?)",
  ).bind(
    generation,
    seed.recording_key ?? `spotify:${spotifyId}`,
    spotifyId,
    seed.isrc ?? null,
    seed.title ?? "Track",
    seed.image_url === undefined ? `https://i.scdn.co/${spotifyId}` : seed.image_url,
    `https://open.spotify.com/track/${spotifyId}`,
    JSON.stringify(seed.artists ?? [{ id: seed.bucket_artist_id ?? artistId, name: "Artist" }]),
    seed.bucket_artist_id ?? artistId,
  ).run();
}

async function setLive(generation: string | null) {
  if (!generation) {
    await env.DB.prepare("UPDATE refresh_state SET live_generation = NULL, candidate_count = 0, live_bucket_count = 0 WHERE singleton = 1").run();
    return;
  }
  const pool = await rebuildRecommendationPool(env, generation);
  await env.DB.prepare("UPDATE refresh_state SET live_generation = ?, candidate_count = ?, live_bucket_count = ? WHERE singleton = 1").bind(generation, pool.candidateCount, pool.bucketCount).run();
}

async function seedLiveJob(generation: string) {
  await env.DB.prepare("INSERT INTO rebuild_jobs (singleton, generation, status, phase, revision, next_read_at, dispatch_pending, started_at, updated_at) VALUES (1, ?, 'active', 'enrich', 0, 0, 0, 1, 1)").bind(generation).run();
}

async function ownerCookie(spotifyId: string = env.OWNER_SPOTIFY_ID): Promise<string> {
  const raw = "owner-session";
  await env.DB.prepare("INSERT INTO owner_sessions (session_hash, spotify_account_id, expires_at, created_at) VALUES (?, ?, ?, 1)").bind(await hmac(raw), spotifyId, Date.now() + 60_000).run();
  return `ferto_session=${raw}; ferto_csrf=csrf`;
}
function ownerRequest(path: string, cookie: string, body: object): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": "csrf", "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function queueEnv() {
  const send = vi.fn().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  const queue = {
    send,
    metrics: vi.fn().mockResolvedValue({ backlogCount: 0, backlogBytes: 0 }),
    sendBatch: vi.fn().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
  } satisfies Queue;
  return { testEnv: { ...env, REFRESH_QUEUE: queue } as Env, send };
}
const publicGet = (path: string) => SELF.fetch(new Request(`${origin}${path}`));
// Strip full-line // comments only; anchoring at line start keeps https:// URLs inside string values intact.
const wranglerJson = () => JSON.parse(wranglerConfig.replace(/^\s*\/\/.*$/gm, ""));

it("keeps all SPA /api routes in wrangler assets run_worker_first", () => {
  const config = wranglerJson() as { assets?: { run_worker_first?: boolean | string[] } };
  const runWorkerFirst = config.assets?.run_worker_first;
  expect(Array.isArray(runWorkerFirst) && runWorkerFirst.includes("/api/*")).toBe(true);
});

it("schedules the weekly rebuild and quarter-hour watchdog on a serialized retrying queue", () => {
  const config = wranglerJson() as { triggers?: { crons?: string[] }; queues?: { consumers?: { max_batch_size?: number; max_concurrency?: number; retry_delay?: number }[] } };
  expect(config.triggers?.crons).toEqual(["0 3 * * SUN", "*/15 * * * *"]);
  expect(config.queues?.consumers?.[0]).toMatchObject({ max_batch_size: 1, max_concurrency: 1, retry_delay: 30 });
});

describe("Worker routes with the v4 recording schema", () => {
  beforeAll(async () => {
    const sql = [initialMigration, stagingMigration, incrementalMigration, leaseMigration, playlistSkipMigration, refreshAlgorithmMigration, backgroundRefreshMigration, spotifyWaitReasonMigration, v4Migration, identityAndSlotsMigration, atomicPoolMigration, legacyNeverIdentityMigration, neverIdentityChecksMigration, restartReroutedRebuildMigration, preservePreflightGateMigration, resumableQuotaMigration, incrementalDiscoveryMigration, refreshProgressMigration, identityAvailabilityMigration, operationalHistoryMigration, progressivePublicationMigration, oauthProtectionMigration].join("\n");
    for (const statement of statements(sql)) await env.DB.prepare(statement).run();
  });
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM recording_identity_cache"),
      env.DB.prepare("DELETE FROM track_availability"),
      env.DB.prepare("DELETE FROM album_availability_pages"),
      env.DB.prepare("DELETE FROM refresh_history"),
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
      env.DB.prepare("DELETE FROM oauth_states"),
      env.DB.prepare("DELETE FROM request_budgets"),
      env.DB.prepare("DELETE FROM owner_sessions"),
      env.DB.prepare("UPDATE refresh_state SET live_generation = NULL, refreshed_at = NULL, candidate_count = 0, live_bucket_count = 0, last_error = NULL, pending_low = 0, last_outcome = NULL, last_outcome_at = NULL, next_refresh_at = NULL, warnings_json = '{}', last_progress_json = '{}', last_request_counts_json = '{}', last_progress_started_at = NULL, last_progress_partial = 0 WHERE singleton = 1"),
    ]);
  });

  it("protects operational history and returns compact observed counters only to the owner", async () => {
    expect((await worker.fetch(new Request(`${origin}/api/owner/history`), env)).status).toBe(401);
    await env.DB.prepare(`INSERT INTO refresh_history(generation,started_at,finished_at,outcome,progress_json,request_counts_json)
      VALUES ('history-api',1,2,'promoted',?,?)`).bind(JSON.stringify({ newRecordings: 4, stagedRecordings: 20 }),
      JSON.stringify({ tracks: { attempts: 10, succeeded: 10, failed: 0, rateLimited: 0, lastAttemptAt: 2, lastSuccessAt: 2 } })).run();
    const response = await worker.fetch(new Request(`${origin}/api/owner/history`, { headers: { Cookie: await ownerCookie() } }), env);
    expect(response.status).toBe(200);
    const body = await response.json<{ observationBasis: string; history: { discoveriesPerRequest: number }[] }>();
    expect(body.observationBasis).toBe("observed");
    expect(body.history[0].discoveriesPerRequest).toBe(0.4);
    expect(JSON.stringify(body)).not.toContain(env.SPOTIFY_REFRESH_TOKEN);
  });

  describe("public recommendation isolation", () => {
    it("draws through exact slots without catalogue-wide scans", () => {
      const source = workerSource.slice(workerSource.indexOf("async function recommendation"), workerSource.indexOf("async function ownerSession"));
      expect(source).toContain("recommendation_buckets");
      expect(source).toContain("recommendation_slots");
      expect(source).toContain("attempt < 3");
      expect(source).not.toContain("ORDER BY RANDOM()");
      expect(source).not.toMatch(/SELECT\s+(?:DISTINCT|COUNT\()/i);
    });

    it("treats malformed percent-encoding in Cookie as invalid input, not a 500", async () => {
      const response = await worker.fetch(new Request(`${origin}/api/recommendation`, { headers: { Cookie: "bad=%E0%A4%A" } }), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ recommendation: null, candidateCount: 0 });
    });

    it("returns only the recommendation and candidateCount, never refresh internals", async () => {
      await seedRecording("live-1", {
        artists: [
          { id: "ccccccccccccccccccccc", name: "Lead" },
          { id: "ddddddddddddddddddddd", name: "Guest" },
        ],
      });
      await setLive("live-1");
      const body = await (await publicGet("/api/recommendation")).json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["candidateCount", "recommendation"]);
      // The exact public shape: ordered artists, no ISRC, recording key, or
      // any other internal identity or refresh field.
      expect(body.recommendation).toEqual({
        spotify_id: trackId,
        title: "Track",
        artists: [
          { id: "ccccccccccccccccccccc", name: "Lead" },
          { id: "ddddddddddddddddddddd", name: "Guest" },
        ],
        album_name: "Album",
        image_url: `https://i.scdn.co/${trackId}`,
        spotify_url: `https://open.spotify.com/track/${trackId}`,
      });
    });

    it("serves only the live generation while staging stays private", async () => {
      await seedRecording("live-1", { title: "Live track" });
      await setLive("live-1");
      await seedLiveJob("stage-1");
      await seedRecording("stage-1", { spotify_id: otherTrackId, recording_key: `spotify:${otherTrackId}`, title: "Staged track" });
      const body = await (await publicGet("/api/recommendation")).json() as { recommendation: { title: string } | null; candidateCount: number };
      expect(body.recommendation?.title).toBe("Live track");
      expect(body.candidateCount).toBe(1);
    });

    it("reports an empty shelf when nothing is live yet, even with staged candidates", async () => {
      await seedLiveJob("stage-1");
      await seedRecording("stage-1", {});
      const body = await (await publicGet("/api/recommendation")).json() as { recommendation: unknown; candidateCount: number };
      expect(body).toEqual({ recommendation: null, candidateCount: 0 });
    });

    it("excludes only the requested representative for that request", async () => {
      await seedRecording("live-1", {});
      await seedRecording("live-1", { spotify_id: otherTrackId, recording_key: `spotify:${otherTrackId}`, title: "Other" });
      await setLive("live-1");
      // Both recordings share one artist bucket, so excluding either leaves
      // exactly one candidate and the draw is deterministic without depending
      // on which row an unfiltered ORDER BY RANDOM happens to pick.
      const excludingFirst = await (await publicGet(`/api/recommendation?exclude=${trackId}`)).json() as { recommendation: { spotify_id: string } | null; candidateCount: number };
      expect(excludingFirst.recommendation?.spotify_id).toBe(otherTrackId);
      // The exclusion is per request; the count still reports the whole shelf.
      expect(excludingFirst.candidateCount).toBe(2);
      // The complementary request still sees the first representative, so the
      // earlier exclusion provably did not persist for later requests.
      const excludingOther = await (await publicGet(`/api/recommendation?exclude=${otherTrackId}`)).json() as { recommendation: { spotify_id: string } | null; candidateCount: number };
      expect(excludingOther.recommendation?.spotify_id).toBe(trackId);
      expect(excludingOther.candidateCount).toBe(2);
      const unfiltered = await (await publicGet("/api/recommendation")).json() as { recommendation: { spotify_id: string } | null; candidateCount: number };
      expect(unfiltered.candidateCount).toBe(2);
      expect([trackId, otherTrackId]).toContain(unfiltered.recommendation?.spotify_id);
    });

    it("ignores an exclude value that is not a Spotify track id", async () => {
      await seedRecording("live-1", {});
      await setLive("live-1");
      const body = await (await publicGet("/api/recommendation?exclude=not-a-track-id")).json() as { recommendation: { spotify_id: string } | null; candidateCount: number };
      expect(body.recommendation?.spotify_id).toBe(trackId);
      expect(body.candidateCount).toBe(1);
    });

    it("hides never-excluded and known recordings from the live shelf at read time", async () => {
      await seedRecording("live-1", {});
      await seedRecording("live-1", { spotify_id: otherTrackId, recording_key: `spotify:${otherTrackId}`, title: "Known" });
      await setLive("live-1");
      await env.DB.batch([
        env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, NULL, ?, 1)").bind(`spotify:${trackId}`, trackId),
        env.DB.prepare("INSERT INTO rebuild_known_recordings (generation, recording_key) VALUES ('live-1', ?)").bind(`spotify:${otherTrackId}`),
      ]);
      const body = await (await publicGet("/api/recommendation")).json() as { recommendation: unknown; candidateCount: number };
      expect(body).toEqual({ recommendation: null, candidateCount: 0 });
    });

    it("lazily removes an ISRC-keyed slot covered by a legacy id-only Never row", async () => {
      await seedRecording("live-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: trackId });
      await setLive("live-1");
      await env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES (?, NULL, ?, 1)").bind(`spotify:${trackId}`, trackId).run();

      expect(await (await publicGet("/api/recommendation")).json()).toEqual({ recommendation: null, candidateCount: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_slots WHERE generation = 'live-1'").first<{ count: number }>()).toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 0, live_bucket_count: 0 });
    });

    it("draws artist buckets uniformly, not weighted by catalogue size", async () => {
      // One sparse artist against one prolific artist. A row-weighted draw
      // would surface the sparse artist in only ~10% of requests.
      const sparse = "aaaaaaaaaaaaaaaaaaaaa";
      const prolific = "bbbbbbbbbbbbbbbbbbbbb";
      await seedRecording("live-1", { bucket_artist_id: sparse, spotify_id: "0000000000000000000001", recording_key: "spotify:0000000000000000000001", title: "Sparse" });
      for (let index = 2; index <= 10; index += 1) {
        const id = `00000000000000000000${String(index).padStart(2, "0")}`;
        await seedRecording("live-1", { bucket_artist_id: prolific, spotify_id: id, recording_key: `spotify:${id}`, title: `Prolific ${index}` });
      }
      await setLive("live-1");
      let sparseHits = 0;
      for (let draw = 0; draw < 120; draw += 1) {
        const body = await (await publicGet("/api/recommendation")).json() as { recommendation: { title: string } | null };
        if (body.recommendation?.title === "Sparse") sparseHits += 1;
      }
      expect(sparseHits).toBeGreaterThanOrEqual(25);
      expect(sparseHits).toBeLessThanOrEqual(95);
    });

    it("compacts dense track and artist slots after a live exclusion", async () => {
      const firstArtist = "aaaaaaaaaaaaaaaaaaaaa";
      const secondArtist = "bbbbbbbbbbbbbbbbbbbbb";
      const secondTrack = "0000000000000000000002";
      const thirdTrack = "0000000000000000000003";
      await seedRecording("live-1", { bucket_artist_id: firstArtist, recording_key: `spotify:${trackId}`, spotify_id: trackId });
      await seedRecording("live-1", { bucket_artist_id: secondArtist, recording_key: `spotify:${secondTrack}`, spotify_id: secondTrack });
      await seedRecording("live-1", { bucket_artist_id: secondArtist, recording_key: `spotify:${thirdTrack}`, spotify_id: thirdTrack });
      await setLive("live-1");
      expect(await removeFromRecommendationPool(env, "live-1", `spotify:${trackId}`)).toBe(true);
      expect(await removeFromRecommendationPool(env, "live-1", `spotify:${secondTrack}`)).toBe(true);
      const state = await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first();
      expect(state).toEqual({ candidate_count: 1, live_bucket_count: 1 });
      expect(await env.DB.prepare("SELECT bucket_slot, track_count FROM recommendation_buckets WHERE generation = 'live-1'").first()).toEqual({ bucket_slot: 1, track_count: 1 });
      expect(await env.DB.prepare("SELECT track_slot, recording_key FROM recommendation_slots WHERE generation = 'live-1'").first()).toEqual({ track_slot: 1, recording_key: `spotify:${thirdTrack}` });
      const body = await (await publicGet("/api/recommendation")).json() as { recommendation: { spotify_id: string } | null; candidateCount: number };
      expect(body).toEqual({ recommendation: expect.objectContaining({ spotify_id: thirdTrack }), candidateCount: 1 });
    });

    it("serializes duplicate concurrent removals without double-decrementing", async () => {
      const firstArtist = "aaaaaaaaaaaaaaaaaaaaa";
      const secondTrack = "0000000000000000000002";
      await seedRecording("live-1", { bucket_artist_id: firstArtist, recording_key: `spotify:${trackId}`, spotify_id: trackId });
      await seedRecording("live-1", { bucket_artist_id: firstArtist, recording_key: `spotify:${secondTrack}`, spotify_id: secondTrack });
      await setLive("live-1");

      const removed = await Promise.all([
        removeFromRecommendationPool(env, "live-1", `spotify:${trackId}`),
        removeFromRecommendationPool(env, "live-1", `spotify:${trackId}`),
      ]);

      expect(removed.sort()).toEqual([false, true]);
      expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 1, live_bucket_count: 1 });
      expect(await env.DB.prepare("SELECT track_slot, recording_key FROM recommendation_slots WHERE generation = 'live-1'").first()).toEqual({ track_slot: 1, recording_key: `spotify:${secondTrack}` });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_pool_removals").first()).toEqual({ count: 0 });
    });

    it("serializes different concurrent removals without leaving dense-slot holes", async () => {
      const firstTrack = "0000000000000000000001";
      const secondTrack = "0000000000000000000002";
      const thirdTrack = "0000000000000000000003";
      await seedRecording("live-1", { bucket_artist_id: "aaaaaaaaaaaaaaaaaaaaa", recording_key: `spotify:${firstTrack}`, spotify_id: firstTrack });
      await seedRecording("live-1", { bucket_artist_id: "bbbbbbbbbbbbbbbbbbbbb", recording_key: `spotify:${secondTrack}`, spotify_id: secondTrack });
      await seedRecording("live-1", { bucket_artist_id: "ccccccccccccccccccccc", recording_key: `spotify:${thirdTrack}`, spotify_id: thirdTrack });
      await setLive("live-1");

      expect(await Promise.all([
        removeFromRecommendationPool(env, "live-1", `spotify:${firstTrack}`),
        removeFromRecommendationPool(env, "live-1", `spotify:${secondTrack}`),
      ])).toEqual([true, true]);

      expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 1, live_bucket_count: 1 });
      expect(await env.DB.prepare("SELECT bucket_slot, bucket_artist_id FROM recommendation_buckets WHERE generation = 'live-1'").first()).toEqual({ bucket_slot: 1, bucket_artist_id: "ccccccccccccccccccccc" });
      expect(await env.DB.prepare("SELECT track_slot, recording_key FROM recommendation_slots WHERE generation = 'live-1'").first()).toEqual({ track_slot: 1, recording_key: `spotify:${thirdTrack}` });
    });

    it("serializes concurrent removals from the same artist bucket", async () => {
      const artist = "aaaaaaaaaaaaaaaaaaaaa";
      const firstTrack = "0000000000000000000001";
      const secondTrack = "0000000000000000000002";
      const thirdTrack = "0000000000000000000003";
      for (const id of [firstTrack, secondTrack, thirdTrack]) {
        await seedRecording("live-1", { bucket_artist_id: artist, recording_key: `spotify:${id}`, spotify_id: id });
      }
      await setLive("live-1");

      expect(await Promise.all([
        removeFromRecommendationPool(env, "live-1", `spotify:${firstTrack}`),
        removeFromRecommendationPool(env, "live-1", `spotify:${secondTrack}`),
      ])).toEqual([true, true]);
      expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 1, live_bucket_count: 1 });
      expect(await env.DB.prepare("SELECT track_slot, recording_key FROM recommendation_slots WHERE generation = 'live-1'").first()).toEqual({ track_slot: 1, recording_key: `spotify:${thirdTrack}` });
      expect(await env.DB.prepare("SELECT bucket_slot, track_count FROM recommendation_buckets WHERE generation = 'live-1'").first()).toEqual({ bucket_slot: 1, track_count: 1 });
    });

    it("appends live bootstrap deltas idempotently without catalogue-wide recounts", async () => {
      const firstArtist = "aaaaaaaaaaaaaaaaaaaaa";
      const secondArtist = "bbbbbbbbbbbbbbbbbbbbb";
      const secondTrack = "0000000000000000000002";
      const thirdTrack = "0000000000000000000003";
      await seedRecording("live-1", { bucket_artist_id: firstArtist, recording_key: `spotify:${trackId}`, spotify_id: trackId });
      await setLive("live-1");

      await seedRecording("live-1", { bucket_artist_id: firstArtist, recording_key: `spotify:${secondTrack}`, spotify_id: secondTrack });
      await appendRecommendationPool(env, "live-1", firstArtist);
      await appendRecommendationPool(env, "live-1", firstArtist);
      await seedRecording("live-1", { bucket_artist_id: secondArtist, recording_key: `spotify:${thirdTrack}`, spotify_id: thirdTrack });
      await appendRecommendationPool(env, "live-1", secondArtist);

      expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 3, live_bucket_count: 2 });
      expect((await env.DB.prepare("SELECT bucket_slot, bucket_artist_id, track_count FROM recommendation_buckets WHERE generation = 'live-1' ORDER BY bucket_slot").all()).results).toEqual([
        { bucket_slot: 1, bucket_artist_id: firstArtist, track_count: 2 },
        { bucket_slot: 2, bucket_artist_id: secondArtist, track_count: 1 },
      ]);
      expect((await env.DB.prepare("SELECT bucket_artist_id, track_slot FROM recommendation_slots WHERE generation = 'live-1' ORDER BY bucket_artist_id, track_slot").all()).results).toEqual([
        { bucket_artist_id: firstArtist, track_slot: 1 },
        { bucket_artist_id: firstArtist, track_slot: 2 },
        { bucket_artist_id: secondArtist, track_slot: 1 },
      ]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_pool_appends").first()).toEqual({ count: 0 });
    });

    it("serializes a bootstrap append racing a live removal", async () => {
      const artist = "aaaaaaaaaaaaaaaaaaaaa";
      const secondTrack = "0000000000000000000002";
      await seedRecording("live-1", { bucket_artist_id: artist, recording_key: `spotify:${trackId}`, spotify_id: trackId });
      await setLive("live-1");
      await seedRecording("live-1", { bucket_artist_id: artist, recording_key: `spotify:${secondTrack}`, spotify_id: secondTrack });
      await env.DB.prepare("INSERT INTO rebuild_known_recordings (generation, recording_key) VALUES ('live-1', ?)").bind(`spotify:${trackId}`).run();

      const [, removed] = await Promise.all([
        appendRecommendationPool(env, "live-1", artist),
        removeFromRecommendationPool(env, "live-1", `spotify:${trackId}`),
      ]);

      expect(removed).toBe(true);
      expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 1, live_bucket_count: 1 });
      expect(await env.DB.prepare("SELECT track_slot, recording_key FROM recommendation_slots WHERE generation = 'live-1'").first()).toEqual({ track_slot: 1, recording_key: `spotify:${secondTrack}` });
    });
  });

  describe("owner authentication", () => {
    it("routes a navigational owner OAuth callback to the Worker instead of the SPA fallback", async () => {
      const response = await SELF.fetch(new Request(`${origin}/api/owner/callback?code=test-auth-code&state=unseeded-callback-state`, { headers: { "Sec-Fetch-Mode": "navigate" } }));
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "expired OAuth state" });
    });

    it("starts owner login for a same-origin CSRF-valid POST with an identity-only scope", async () => {
      const response = await SELF.fetch(ownerRequest("/api/owner/login", "ferto_csrf=csrf", {}));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/json");
      const text = await response.text();
      const authorizeUrl = new URL((JSON.parse(text) as { authorizeUrl: string }).authorizeUrl);
      expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe("https://accounts.spotify.com/authorize");
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${origin}/api/owner/callback`);
      expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizeUrl.searchParams.get("scope")).toBe("user-read-private");
      expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
      const state = await env.DB.prepare("SELECT code_verifier FROM oauth_states").first<{ code_verifier: string }>();
      expect(state?.code_verifier).toBeTruthy();
      expect(text).not.toContain("client_secret");
      expect(text).not.toContain(env.SESSION_SECRET);
      expect(text).not.toContain(env.SPOTIFY_REFRESH_TOKEN);
      expect(text).not.toContain(state?.code_verifier ?? "");
    });

    it("fails login with no OAuth state when the client id is a checked-in placeholder", async () => {
      const misconfigured = { ...env, SPOTIFY_CLIENT_ID: "REPLACE_WITH_SPOTIFY_CLIENT_ID" };
      const response = await worker.fetch(ownerRequest("/api/owner/login", "ferto_csrf=csrf", {}), misconfigured);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "owner sign-in is not configured" });
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_states").first<{ count: number }>()).toMatchObject({ count: 0 });
    });

    it("completes a successful owner OAuth callback with a 302 session cookie redirect", async () => {
      const loginResponse = await SELF.fetch(ownerRequest("/api/owner/login", "ferto_csrf=csrf", {}));
      const browserCookie = loginResponse.headers.get("Set-Cookie")!.split(";")[0];
      const login = await loginResponse.json() as { authorizeUrl: string };
      const state = new URL(login.authorizeUrl).searchParams.get("state");
      expect(state).toBeTruthy();
      // Plain bodyless mocks: stream-backed Responses built here cannot be read from SELF.fetch's worker request context.
      const jsonResponse = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: "callback-access-token", token_type: "Bearer", expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ account_id: env.OWNER_SPOTIFY_ID, id: "mutable-owner-user-id" })));
      const response = await SELF.fetch(new Request(`${origin}/api/owner/callback?code=oauth-code&state=${encodeURIComponent(state ?? "")}`, { headers: { "Sec-Fetch-Mode": "navigate", Cookie: browserCookie }, redirect: "manual" }));
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(`${origin}/?owner=1`);
      const setCookie = response.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toContain("ferto_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Max-Age=604800");
      const raw = decodeURIComponent(/ferto_session=([^;]+)/.exec(setCookie)?.[1] ?? "");
      const row = await env.DB.prepare("SELECT spotify_account_id FROM owner_sessions WHERE session_hash = ?").bind(await hmac(raw)).first<{ spotify_account_id: string }>();
      expect(row?.spotify_account_id).toBe(env.OWNER_SPOTIFY_ID);
    });

    it("exchanges the callback code with PKCE client_id and verifier, without a client secret", async () => {
      const loginResponse = await SELF.fetch(ownerRequest("/api/owner/login", "ferto_csrf=csrf", {}));
      const browserCookie = loginResponse.headers.get("Set-Cookie")!.split(";")[0];
      const login = await loginResponse.json() as { authorizeUrl: string };
      const state = new URL(login.authorizeUrl).searchParams.get("state");
      expect(state).toBeTruthy();
      const jsonResponse = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: "callback-access-token", token_type: "Bearer", expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ account_id: env.OWNER_SPOTIFY_ID, id: "mutable-owner-user-id" }));
      vi.stubGlobal("fetch", fetchSpy);
      const response = await SELF.fetch(new Request(`${origin}/api/owner/callback?code=oauth-code&state=${encodeURIComponent(state ?? "")}`, { headers: { "Sec-Fetch-Mode": "navigate", Cookie: browserCookie }, redirect: "manual" }));
      expect(response.status).toBe(302);
      const tokenCall = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(tokenCall[0]).toBe("https://accounts.spotify.com/api/token");
      const form = new URLSearchParams(String(tokenCall[1].body));
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("client_id")).toBe(env.SPOTIFY_CLIENT_ID);
      expect(form.has("client_secret")).toBe(false);
      expect(form.get("code_verifier")).toBeTruthy();
      expect(new Headers(tokenCall[1].headers).has("Authorization")).toBe(false);
      expect(await response.text()).toBe("");
    });

    it("rejects a matching mutable user id when the immutable account_id is not the owner", async () => {
      const loginResponse = await SELF.fetch(ownerRequest("/api/owner/login", "ferto_csrf=csrf", {}));
      const browserCookie = loginResponse.headers.get("Set-Cookie")!.split(";")[0];
      const login = await loginResponse.json() as { authorizeUrl: string };
      const state = new URL(login.authorizeUrl).searchParams.get("state");
      const jsonResponse = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: "callback-access-token" }))
        .mockResolvedValueOnce(jsonResponse({ account_id: "different-account", id: env.OWNER_SPOTIFY_ID })));
      const response = await SELF.fetch(new Request(`${origin}/api/owner/callback?code=oauth-code&state=${encodeURIComponent(state ?? "")}`, { headers: { Cookie: browserCookie }, redirect: "manual" }));
      expect(response.status).toBe(403);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_sessions").first<{ count: number }>()).toEqual({ count: 0 });
    });

    it("rejects visitor writes even with a valid origin and CSRF token", async () => {
      const response = await worker.fetch(ownerRequest("/api/owner/never-again", "ferto_csrf=csrf", { trackId }), env);
      expect(response.status).toBe(401);
      expect(await worker.fetch(ownerRequest("/api/owner/like", "ferto_csrf=csrf", { trackId }), env)).toHaveProperty("status", 401);
    });

    it("rejects a session for a Spotify account that is not the configured owner", async () => {
      const response = await worker.fetch(ownerRequest("/api/owner/never-again", await ownerCookie("different-owner"), { trackId }), env);
      expect(response.status).toBe(401);
    });

    it("rejects cross-origin and missing-CSRF owner writes before any Spotify call", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const cookie = await ownerCookie();
      const crossOrigin = new Request(`${origin}/api/owner/like`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: cookie, "X-CSRF-Token": "csrf", "Content-Type": "application/json" }, body: JSON.stringify({ trackId }) });
      expect((await worker.fetch(crossOrigin, env)).status).toBe(403);
      const missingCsrf = new Request(`${origin}/api/owner/like`, { method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ trackId }) });
      expect((await worker.fetch(missingCsrf, env)).status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects a like or never without a valid track id", async () => {
      const cookie = await ownerCookie();
      expect((await worker.fetch(ownerRequest("/api/owner/like", cookie, { trackId: "short" }), env)).status).toBe(400);
      expect((await worker.fetch(ownerRequest("/api/owner/never-again", cookie, {}), env)).status).toBe(400);
    });
  });

  describe("Like", () => {
    const tokenOk = () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { headers: { "Content-Type": "application/json" } });

    it("saves to Spotify first and excludes the recording from live and active staging afterwards", async () => {
      await seedRecording("live-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001" });
      await setLive("live-1");
      await seedLiveJob("stage-1");
      await seedRecording("stage-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001" });
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      const response = await worker.fetch(ownerRequest("/api/owner/like", await ownerCookie(), { trackId }), env);
      expect(response.status).toBe(200);
      expect(fetchSpy.mock.calls[0][0]).toBe("https://accounts.spotify.com/api/token");
      const refreshInit = fetchSpy.mock.calls[0][1] as RequestInit;
      const refreshForm = new URLSearchParams(String(refreshInit.body));
      expect(refreshForm.get("client_id")).toBe(env.SPOTIFY_CLIENT_ID);
      expect(refreshForm.has("client_secret")).toBe(false);
      expect(new Headers(refreshInit.headers).has("Authorization")).toBe(false);
      const library = new URL(String(fetchSpy.mock.calls[1][0]));
      expect(`${library.origin}${library.pathname}`).toBe("https://api.spotify.com/v1/me/library");
      expect(library.searchParams.get("uris")).toBe(`spotify:track:${trackId}`);
      expect((fetchSpy.mock.calls[1][1] as RequestInit).body).toBeUndefined();
      const overlays = await env.DB.prepare("SELECT generation, recording_key FROM rebuild_known_recordings ORDER BY generation").all<{ generation: string; recording_key: string }>();
      expect(overlays.results).toEqual([{ generation: "live-1", recording_key: "isrc:USABC2100001" }, { generation: "stage-1", recording_key: "isrc:USABC2100001" }]);
      const body = await (await publicGet("/api/recommendation")).json() as { recommendation: unknown; candidateCount: number };
      expect(body).toEqual({ recommendation: null, candidateCount: 0 });
    });

    it("resolves a stale card after promotion and excludes the current representative by ISRC", async () => {
      // The browser still holds the old id after live-2 has replaced it. A
      // conflicting legacy id-only row ensures ISRC identity wins resolution.
      await seedRecording("legacy", { spotify_id: trackId, recording_key: `spotify:${trackId}`, title: "Legacy alias" });
      await seedRecording("live-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: trackId, title: "Old card" });
      await seedRecording("live-2", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: otherTrackId, title: "Current representative" });
      await setLive("live-2");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(new Response("", { status: 200 })));
      const response = await worker.fetch(ownerRequest("/api/owner/like", await ownerCookie(), { trackId }), env);
      expect(response.status).toBe(200);
      expect(await (await publicGet("/api/recommendation")).json()).toEqual({ recommendation: null, candidateCount: 0 });
      const overlay = await env.DB.prepare("SELECT generation, recording_key FROM rebuild_known_recordings").first<{ generation: string; recording_key: string }>();
      expect(overlay).toEqual({ generation: "live-2", recording_key: "isrc:USABC2100001" });
    });

    it("removes a legacy live alias when staging already knows its ISRC", async () => {
      await seedRecording("legacy-live", { recording_key: `spotify:${trackId}`, spotify_id: trackId });
      await setLive("legacy-live");
      await seedLiveJob("stage-1");
      await seedRecording("stage-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: trackId });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(new Response("", { status: 200 })));

      expect((await worker.fetch(ownerRequest("/api/owner/like", await ownerCookie(), { trackId }), env)).status).toBe(200);
      expect(await (await publicGet("/api/recommendation")).json()).toEqual({ recommendation: null, candidateCount: 0 });
      expect((await env.DB.prepare("SELECT generation, recording_key FROM rebuild_known_recordings ORDER BY generation, recording_key").all()).results).toEqual([
        { generation: "legacy-live", recording_key: "isrc:USABC2100001" },
        { generation: "legacy-live", recording_key: `spotify:${trackId}` },
        { generation: "stage-1", recording_key: "isrc:USABC2100001" },
      ]);
    });

    it("resolves an exact-id stale card to the current different Spotify representative", async () => {
      await seedRecording("legacy", { recording_key: `spotify:${trackId}`, spotify_id: trackId, title: "Old exact-id card" });
      await seedRecording("live-2", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: otherTrackId, title: "Current representative" });
      await setLive("live-2");
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: trackId, external_ids: { isrc: "US-ABC-21-00001" } }), { headers: { "Content-Type": "application/json" } }))
        .mockResolvedValueOnce(new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);

      expect((await worker.fetch(ownerRequest("/api/owner/like", await ownerCookie(), { trackId }), env)).status).toBe(200);
      expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
        "https://accounts.spotify.com/api/token",
        `https://api.spotify.com/v1/tracks/${trackId}`,
        expect.stringContaining("https://api.spotify.com/v1/me/library"),
      ]);
      expect(await (await publicGet("/api/recommendation")).json()).toEqual({ recommendation: null, candidateCount: 0 });
      expect(await env.DB.prepare("SELECT generation, recording_key FROM rebuild_known_recordings").first()).toEqual({ generation: "live-2", recording_key: "isrc:USABC2100001" });
    });

    it("confirms a legacy live card while active staging uses a different representative", async () => {
      await seedRecording("legacy-live", { recording_key: `spotify:${trackId}`, spotify_id: trackId, title: "Legacy card" });
      await setLive("legacy-live");
      await seedLiveJob("stage-1");
      await seedRecording("stage-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: otherTrackId, title: "Staged representative" });
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: otherTrackId, external_ids: { isrc: "US-ABC-21-00001" } }), { headers: { "Content-Type": "application/json" } }))
        .mockResolvedValueOnce(new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);

      expect((await worker.fetch(ownerRequest("/api/owner/like", await ownerCookie(), { trackId }), env)).status).toBe(200);

      expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
        "https://accounts.spotify.com/api/token",
        `https://api.spotify.com/v1/tracks/${trackId}`,
        expect.stringContaining("https://api.spotify.com/v1/me/library"),
      ]);
      expect((await env.DB.prepare("SELECT generation, recording_key FROM rebuild_known_recordings ORDER BY generation, recording_key").all()).results).toEqual([
        { generation: "legacy-live", recording_key: "isrc:USABC2100001" },
        { generation: "legacy-live", recording_key: `spotify:${trackId}` },
        { generation: "stage-1", recording_key: "isrc:USABC2100001" },
      ]);
      expect(await (await publicGet("/api/recommendation")).json()).toEqual({ recommendation: null, candidateCount: 0 });
    });

    it("does not save a stale exact-id card when identity confirmation is transiently unavailable", async () => {
      await seedRecording("legacy", { recording_key: `spotify:${trackId}`, spotify_id: trackId });
      await seedRecording("live-2", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: otherTrackId });
      await setLive("live-2");
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(new Response("no", { status: 500 }));
      vi.stubGlobal("fetch", fetchSpy);

      expect((await worker.fetch(ownerRequest("/api/owner/like", await ownerCookie(), { trackId }), env)).status).toBe(503);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect((await (await publicGet("/api/recommendation")).json() as { recommendation: { spotify_id: string } | null }).recommendation?.spotify_id).toBe(otherTrackId);
    });

    it("retains the candidate when the Spotify save fails upstream", async () => {
      await seedRecording("live-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001" });
      await setLive("live-1");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(new Response("no", { status: 500 })));
      const response = await worker.fetch(ownerRequest("/api/owner/like", await ownerCookie(), { trackId }), env);
      expect(response.status).toBe(502);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_known_recordings").first<{ count: number }>()).toMatchObject({ count: 0 });
      const body = await (await publicGet("/api/recommendation")).json() as { recommendation: { spotify_id: string } | null; candidateCount: number };
      expect(body.recommendation?.spotify_id).toBe(trackId);
      expect(body.candidateCount).toBe(1);
    });
  });

  describe("Never Again", () => {
    const tokenOk = () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { headers: { "Content-Type": "application/json" } });
    const trackResponse = (isrc: string | null, status = 200) => new Response(JSON.stringify({ id: trackId, external_ids: isrc ? { isrc } : {} }), { status, headers: { "Content-Type": "application/json" } });

    it("uses an ISRC-confirmed live identity directly without another Spotify call", async () => {
      await seedRecording("live-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001" });
      await setLive("live-1");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const response = await worker.fetch(ownerRequest("/api/owner/never-again", await ownerCookie(), { trackId }), env);
      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      const row = await env.DB.prepare("SELECT recording_key, isrc, spotify_id FROM never_recordings").first<{ recording_key: string; isrc: string | null; spotify_id: string }>();
      expect(row).toMatchObject({ recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: trackId });
      expect((await (await publicGet("/api/recommendation")).json() as { recommendation: unknown }).recommendation).toBeNull();
    });

    it("confirms a legacy id-only identity with an immediate full-track lookup", async () => {
      await seedRecording("legacy-live", {});
      await setLive("legacy-live");
      const fetchSpy = vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(trackResponse("us-abc-21-00001"));
      vi.stubGlobal("fetch", fetchSpy);
      const response = await worker.fetch(ownerRequest("/api/owner/never-again", await ownerCookie(), { trackId }), env);
      expect(response.status).toBe(200);
      expect(fetchSpy.mock.calls[1][0]).toBe(`https://api.spotify.com/v1/tracks/${trackId}`);
      const row = await env.DB.prepare("SELECT recording_key, isrc FROM never_recordings").first<{ recording_key: string; isrc: string | null }>();
      expect(row).toMatchObject({ recording_key: "isrc:USABC2100001", isrc: "USABC2100001" });
      expect(await (await publicGet("/api/recommendation")).json()).toEqual({ recommendation: null, candidateCount: 0 });
    });

    it("removes a legacy live alias when an active rebuild already has the ISRC", async () => {
      await seedRecording("legacy-live", { recording_key: `spotify:${trackId}`, spotify_id: trackId });
      await setLive("legacy-live");
      await seedLiveJob("stage-1");
      await seedRecording("stage-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: trackId });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      expect((await worker.fetch(ownerRequest("/api/owner/never-again", await ownerCookie(), { trackId }), env)).status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT recording_key FROM never_recordings").first()).toEqual({ recording_key: "isrc:USABC2100001" });
      expect(await (await publicGet("/api/recommendation")).json()).toEqual({ recommendation: null, candidateCount: 0 });
      expect((await env.DB.prepare("SELECT generation, recording_key FROM rebuild_known_recordings ORDER BY generation, recording_key").all()).results).toContainEqual({ generation: "legacy-live", recording_key: `spotify:${trackId}` });
    });

    it("keeps an exact-id exclusion when the confirmed track has no ISRC", async () => {
      await seedRecording("legacy-live", {});
      await setLive("legacy-live");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(trackResponse(null)));
      const response = await worker.fetch(ownerRequest("/api/owner/never-again", await ownerCookie(), { trackId }), env);
      expect(response.status).toBe(200);
      expect(await env.DB.prepare("SELECT recording_key FROM never_recordings").first<{ recording_key: string }>()).toMatchObject({ recording_key: `spotify:${trackId}` });
    });

    it("fails closed on a transient lookup failure instead of weakening the identity", async () => {
      await seedRecording("legacy-live", {});
      await setLive("legacy-live");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(trackResponse(null, 500)));
      const response = await worker.fetch(ownerRequest("/api/owner/never-again", await ownerCookie(), { trackId }), env);
      expect(response.status).toBe(503);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM never_recordings").first<{ count: number }>()).toMatchObject({ count: 0 });
      const body = await (await publicGet("/api/recommendation")).json() as { recommendation: { spotify_id: string } | null };
      expect(body.recommendation?.spotify_id).toBe(trackId);
    });

    it("stores an exact-id exclusion when the track object itself is gone", async () => {
      await seedRecording("legacy-live", {});
      await setLive("legacy-live");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(trackResponse(null, 404)));
      const response = await worker.fetch(ownerRequest("/api/owner/never-again", await ownerCookie(), { trackId }), env);
      expect(response.status).toBe(200);
      expect(await env.DB.prepare("SELECT recording_key FROM never_recordings").first<{ recording_key: string }>()).toMatchObject({ recording_key: `spotify:${trackId}` });
    });

    it("is idempotent when the same recording is excluded twice", async () => {
      await seedRecording("live-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001" });
      await setLive("live-1");
      const cookie = await ownerCookie();
      expect((await worker.fetch(ownerRequest("/api/owner/never-again", cookie, { trackId }), env)).status).toBe(200);
      expect((await worker.fetch(ownerRequest("/api/owner/never-again", cookie, { trackId }), env)).status).toBe(200);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM never_recordings").first<{ count: number }>()).toMatchObject({ count: 1 });
    });

    it("applies recording-wide across rebuilds with a different representative", async () => {
      await seedRecording("live-1", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: trackId });
      await setLive("live-1");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      expect((await worker.fetch(ownerRequest("/api/owner/never-again", await ownerCookie(), { trackId }), env)).status).toBe(200);
      // A later rebuild promotes the same recording under another Spotify id.
      await seedRecording("live-2", { recording_key: "isrc:USABC2100001", isrc: "USABC2100001", spotify_id: otherTrackId });
      await setLive("live-2");
      expect((await (await publicGet("/api/recommendation")).json() as { candidateCount: number }).candidateCount).toBe(0);
    });
  });

  describe("refresh status surface", () => {
    it("starts an idle rebuild from an owner-authenticated CSRF-protected POST", async () => {
      const cookie = await ownerCookie();
      const { testEnv, send } = queueEnv();
      const response = await worker.fetch(ownerRequest("/api/owner/refresh", cookie, {}), testEnv);
      expect(response.status).toBe(202);
      const body = await response.json() as { state: string; refreshId: string; phase: string };
      expect(body).toMatchObject({ state: "active", phase: "preflight" });
      expect(body.refreshId).toMatch(/^v4-/);
      expect(send).toHaveBeenCalledWith({ generation: body.refreshId, revision: 0 }, { contentType: "json" });
    });

    it("wakes an active generation without creating a duplicate job", async () => {
      await seedLiveJob("stage-1");
      const cookie = await ownerCookie();
      const { testEnv, send } = queueEnv();
      const response = await worker.fetch(ownerRequest("/api/owner/refresh", cookie, {}), testEnv);
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ state: "active", refreshId: "stage-1" });
      expect(send).toHaveBeenCalledWith({ generation: "stage-1", revision: 0 }, { contentType: "json" });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_jobs").first<{ count: number }>()).toEqual({ count: 1 });
      expect(await env.DB.prepare("SELECT generation FROM rebuild_jobs").first<{ generation: string }>()).toEqual({ generation: "stage-1" });
    });

    it("wakes waiting discovery to publish staging without clearing its durable retry gate", async () => {
      await seedLiveJob("waiting-1");
      await env.DB.prepare("UPDATE rebuild_jobs SET retry_at = ? WHERE generation = 'waiting-1'").bind(Date.now() + 60_000).run();
      const { testEnv, send } = queueEnv();
      const response = await worker.fetch(ownerRequest("/api/owner/refresh", await ownerCookie(), {}), testEnv);
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ state: "waiting", refreshId: "waiting-1" });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toEqual({ generation: "waiting-1", revision: 0 });
      expect(send.mock.calls[0][1]).toEqual({ contentType: "json" });
      expect((await env.DB.prepare("SELECT retry_at FROM rebuild_jobs").first<{ retry_at: number }>())!.retry_at).toBeGreaterThan(Date.now());
    });

    it("restarts a failed rebuild with a fresh generation", async () => {
      await env.DB.prepare("INSERT INTO rebuild_jobs (singleton, generation, status, phase, revision, next_read_at, dispatch_pending, started_at, updated_at) VALUES (1, 'failed-1', 'failed', 'seeds', 4, 0, 0, 1, 1)").run();
      const { testEnv, send } = queueEnv();
      const response = await worker.fetch(ownerRequest("/api/owner/refresh", await ownerCookie(), {}), testEnv);
      expect(response.status).toBe(202);
      const body = await response.json() as { refreshId: string; state: string };
      expect(body.state).toBe("active");
      expect(body.refreshId).not.toBe("failed-1");
      expect(send).toHaveBeenCalledWith({ generation: body.refreshId, revision: 0 }, { contentType: "json" });
    });

    it("rejects visitor, cross-origin, and missing-CSRF refresh triggers", async () => {
      const cookie = await ownerCookie();
      expect((await worker.fetch(ownerRequest("/api/owner/refresh", "ferto_csrf=csrf", {}), env)).status).toBe(401);
      const crossOrigin = new Request(`${origin}/api/owner/refresh`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: cookie, "X-CSRF-Token": "csrf" } });
      expect((await worker.fetch(crossOrigin, env)).status).toBe(403);
      const missingCsrf = new Request(`${origin}/api/owner/refresh`, { method: "POST", headers: { Origin: origin, Cookie: cookie } });
      expect((await worker.fetch(missingCsrf, env)).status).toBe(403);
    });

    it("keeps authenticated status bounded while exposing phase, outcome, warnings, and next schedule", async () => {
      await seedLiveJob("stage-1");
      await env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id) VALUES ('stage-1', ?)").bind(artistId).run();
      await env.DB.prepare("UPDATE refresh_state SET last_outcome = 'promoted', next_refresh_at = 123456, warnings_json = ? WHERE singleton = 1").bind(JSON.stringify({ artistsUnavailable: 2 })).run();
      const response = await worker.fetch(new Request(`${origin}/api/owner/refresh`, { headers: { Cookie: await ownerCookie() } }), env);
      expect(response.status).toBe(200);
      const body = await response.json() as { state: string; refreshId: string; phase: string; progress: Record<string, number>; latestOutcome: string; warnings: string[]; nextRefreshAt: number | null };
      expect(body).toMatchObject({ state: "active", refreshId: "stage-1", phase: "enrich", latestOutcome: "promoted", nextRefreshAt: 123456 });
      expect(body.progress).toEqual({});
      expect(body.warnings).toEqual(["2 artists unavailable"]);
    });

    it("hides refresh status from visitors", async () => {
      expect((await worker.fetch(new Request(`${origin}/api/owner/refresh`), env)).status).toBe(401);
      const session = await (await publicGet("/api/owner/session")).json() as { authenticated: boolean; refresh: unknown };
      expect(session).toEqual({ authenticated: false, refresh: null });
    });
  });

  describe("removed playback surface", () => {
    it("keeps the PKCE-only runtime contract free of a Spotify client secret", () => {
      for (const source of [wranglerConfig, generatedWorkerTypes, secretBindings, viteConfig]) {
        expect(source).not.toContain("SPOTIFY_CLIENT_SECRET");
      }
    });

    it("answers 404 for the playback-token endpoint and configures no playback secret", async () => {
      const cookie = await ownerCookie();
      expect((await worker.fetch(ownerRequest("/api/owner/playback-token", cookie, {}), env)).status).toBe(404);
      expect((await worker.fetch(new Request(`${origin}/api/owner/playback-token`), env)).status).toBe(404);
      // A developer's ignored .dev.vars may still hold a stale binding, so the
      // runtime env proves nothing here; the checked-in contract does: the
      // wrangler config, the generated worker types, the secret declarations,
      // and the checked-in test bindings all stay free of playback secrets.
      const config = wranglerJson() as { vars?: Record<string, string> };
      expect(Object.keys(config.vars ?? {}).some((key) => key.includes("PLAYBACK"))).toBe(false);
      expect(wranglerConfig.toUpperCase()).not.toContain("PLAYBACK");
      expect(generatedWorkerTypes.toUpperCase()).not.toContain("PLAYBACK");
      expect(secretBindings.toUpperCase()).not.toContain("PLAYBACK");
      expect(viteConfig.toUpperCase()).not.toContain("PLAYBACK");
    });
  });
});
