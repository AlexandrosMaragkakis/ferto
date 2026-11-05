import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
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

const keepTrack = "1234567890123456789012";
const neverKeepTrack = "abcdefghijklmnopqrstuv";
const neverOnlyTrack = "0123456789012345678901";
const artistId = "zyxwvutsrqponmlkjihgfe";

/**
 * Split SQL into single statements the way D1 does: semicolons inside string
 * literals or -- / block comments do not end a statement, and chunks that hold
 * only comments (or whitespace) are not statements at all.
 */
function statements(sql: string): string[] {
  const parts: string[] = [];
  let current = "";
  const push = () => {
    parts.push(current.trim());
    current = "";
  };
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    if (char === "-" && sql[i + 1] === "-") {
      for (; i < sql.length && sql[i] !== "\n"; i += 1);
      current += " ";
    } else if (char === "/" && sql[i + 1] === "*") {
      for (i += 2; i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/"); i += 1);
      // Step onto the closing "/" so the loop increment lands after the comment;
      // without this the trailing "/" leaks into the next chunk as a non-statement.
      i += 1;
      current += " ";
    } else if (char === "'") {
      current += char;
      for (i += 1; i < sql.length; i += 1) {
        current += sql[i];
        if (sql[i] === "'") break;
      }
    } else if (char === ";") {
      push();
    } else {
      current += char;
    }
  }
  push();
  return parts.filter(Boolean);
}

async function run(sql: string) {
  for (const statement of statements(sql)) await env.DB.prepare(statement).run();
}

describe("D1-style statement splitting", () => {
  it("never emits a chunk that holds only comments or whitespace", () => {
    const sql = [
      "-- leading line comment",
      "/* block comment ; with a semicolon */",
      "CREATE TABLE a (x INTEGER); -- trailing note",
      "   ",
      "/* standalone block comment */",
      "/* final block comment */",
    ].join("\n");
    expect(statements(sql)).toEqual(["CREATE TABLE a (x INTEGER)"]);
  });

  it("does not split on semicolons inside string literals or comments", () => {
    expect(statements("INSERT INTO t VALUES ('a;b--c');")).toEqual(["INSERT INTO t VALUES ('a;b--c')"]);
    expect(statements("UPDATE t SET x = 'it''s';")).toEqual(["UPDATE t SET x = 'it''s'"]);
    expect(statements("-- one; two\nSELECT 1")).toEqual(["SELECT 1"]);
  });
});

describe("v4 migration upgrade from the legacy schema", () => {
  beforeAll(async () => {
    await run([initialMigration, stagingMigration, incrementalMigration, leaseMigration, playlistSkipMigration, refreshAlgorithmMigration, backgroundRefreshMigration, spotifyWaitReasonMigration].join("\n"));
    // Legacy live shelf, permanent exclusions, and an in-flight legacy refresh.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO candidate_artists (spotify_id, name, image_url, refreshed_at) VALUES (?, 'Artist', NULL, 1)").bind(artistId),
      env.DB.prepare("INSERT INTO candidate_tracks (spotify_id, artist_id, artist_name, title, album_name, image_url, spotify_url, preview_url, refreshed_at) VALUES (?, ?, 'Artist', 'Keep', 'Album', NULL, ?, NULL, 1)").bind(keepTrack, artistId, `https://open.spotify.com/track/${keepTrack}`),
      env.DB.prepare("INSERT INTO candidate_tracks (spotify_id, artist_id, artist_name, title, album_name, image_url, spotify_url, preview_url, refreshed_at) VALUES (?, ?, 'Artist', 'Never', 'Album', NULL, ?, NULL, 1)").bind(neverKeepTrack, artistId, `https://open.spotify.com/track/${neverKeepTrack}`),
      env.DB.prepare("INSERT INTO never_tracks (spotify_id, excluded_at) VALUES (?, 1)").bind(neverKeepTrack),
      env.DB.prepare("INSERT INTO never_tracks (spotify_id, excluded_at) VALUES (?, 1)").bind(neverOnlyTrack),
      env.DB.prepare("INSERT INTO refresh_jobs (singleton, generation, phase, cursor, started_at, updated_at) VALUES (1, 'legacy-job', 'album_tracks', NULL, 1, 1)"),
      env.DB.prepare("INSERT INTO refresh_staging_tracks (generation, spotify_id, artist_id, artist_name, title, album_name, spotify_url) VALUES ('legacy-job', ?, ?, 'Artist', 'Staged', 'Album', ?)").bind("1111111111111111111111", artistId, "https://open.spotify.com/track/1111111111111111111111"),
      env.DB.prepare("INSERT INTO refresh_known_tracks (generation, spotify_id) VALUES ('legacy-job', ?)").bind(keepTrack),
      env.DB.prepare("INSERT INTO refresh_liked_artists (generation, spotify_id) VALUES ('legacy-job', ?)").bind(artistId),
      env.DB.prepare("INSERT INTO refresh_playlist_queue (generation, spotify_id) VALUES ('legacy-job', 'playlist-1')"),
      env.DB.prepare("INSERT INTO refresh_album_queue (generation, spotify_id, album_name) VALUES ('legacy-job', 'album-1', 'Album')"),
      env.DB.prepare("INSERT INTO owner_sessions (session_hash, spotify_user_id, expires_at, created_at) VALUES ('legacy-session', 'mutable-user-id', 9999999999999, 1)"),
      env.DB.prepare("UPDATE refresh_state SET candidate_count = 2, refreshed_at = 123"),
    ]);
    await run(v4Migration);
    await run(identityAndSlotsMigration);
    await run(atomicPoolMigration);
    await run(legacyNeverIdentityMigration);
    await run(neverIdentityChecksMigration);
    await run(restartReroutedRebuildMigration);
    await run(preservePreflightGateMigration);
  });

  it("preserves live candidates as a retained live generation keyed by spotify id", async () => {
    const state = await env.DB.prepare("SELECT live_generation FROM refresh_state WHERE singleton = 1").first<{ live_generation: string | null }>();
    expect(state?.live_generation).toBe("legacy-live");
    const rows = await env.DB.prepare("SELECT recording_key, spotify_id, isrc, title, artists_json, bucket_artist_id FROM recordings WHERE generation = 'legacy-live' ORDER BY recording_key").all<{ recording_key: string; spotify_id: string; isrc: string | null; title: string; artists_json: string; bucket_artist_id: string }>();
    expect(rows.results.map((row) => row.recording_key)).toEqual([`spotify:${keepTrack}`, `spotify:${neverKeepTrack}`].sort());
    for (const row of rows.results) {
      expect(row.isrc).toBeNull();
      expect(row.bucket_artist_id).toBe(artistId);
      expect(JSON.parse(row.artists_json)).toEqual([{ id: artistId, name: "Artist" }]);
    }
    const registry = await env.DB.prepare("SELECT generation, promoted_at FROM recording_generations").first<{ generation: string; promoted_at: number }>();
    expect(registry?.generation).toBe("legacy-live");
    expect(registry?.promoted_at).toBeGreaterThan(0);
  });

  it("preserves legacy Never rows as recording-wide exclusions", async () => {
    const rows = await env.DB.prepare("SELECT recording_key, isrc, spotify_id FROM never_recordings ORDER BY recording_key").all<{ recording_key: string; isrc: string | null; spotify_id: string }>();
    expect(rows.results.map((row) => row.recording_key)).toEqual([`spotify:${neverKeepTrack}`, `spotify:${neverOnlyTrack}`].sort());
    expect(rows.results.every((row) => row.isrc === null)).toBe(true);
    // The never-excluded candidate no longer counts toward the live shelf.
    const count = await env.DB.prepare("SELECT candidate_count FROM refresh_state WHERE singleton = 1").first<{ candidate_count: number }>();
    expect(count?.candidate_count).toBe(1);
  });

  it("discards legacy active job, staging, and work rows", async () => {
    for (const table of ["refresh_jobs", "refresh_staging_tracks", "refresh_known_tracks", "refresh_liked_artists", "refresh_playlist_queue", "refresh_album_queue"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()).toMatchObject({ count: 0 });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recordings WHERE generation <> 'legacy-live'").first<{ count: number }>()).toMatchObject({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_jobs").first<{ count: number }>()).toMatchObject({ count: 0 });
  });

  it("leaves every v4 table and refresh_state column valid and queryable", async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const names = new Set(tables.results.map((row) => row.name));
    const v4Tables = [
      "recordings",
      "recording_generations",
      "never_recordings",
      "never_identity_checks",
      "rebuild_seed_artists",
      "rebuild_album_queue",
      "rebuild_enrich_queue",
      "rebuild_playlist_queue",
      "rebuild_known_recordings",
      "rebuild_jobs",
      "recommendation_slots",
      "recommendation_pool_removals",
      "recommendation_pool_appends",
      "recommendation_buckets",
    ];
    for (const table of v4Tables) expect(names, `missing v4 table ${table}`).toContain(table);
    const columns = await env.DB.prepare("PRAGMA table_info(refresh_state)").all<{ name: string; dflt_value: string | null }>();
    const defaults = new Map(columns.results.map((row) => [row.name, row.dflt_value]));
    expect(defaults.get("live_generation")).toBeNull();
    expect(defaults.get("pending_low")).toBe("0");
    expect(defaults.get("last_outcome")).toBeNull();
    expect(defaults.get("last_outcome_at")).toBeNull();
    expect(defaults.get("next_refresh_at")).toBeNull();
    expect(defaults.get("warnings_json")).toBe("'{}'");
    expect(defaults.get("live_bucket_count")).toBe("0");
  });

  it("backfills dense recommendation slots and invalidates mutable-id sessions", async () => {
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_slots").first<{ count: number }>()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT bucket_slot, track_count FROM recommendation_buckets").first<{ bucket_slot: number; track_count: number }>()).toEqual({ bucket_slot: 1, track_count: 1 });
    expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 1, live_bucket_count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_sessions").first<{ count: number }>()).toEqual({ count: 0 });
    const sessionColumns = await env.DB.prepare("PRAGMA table_info(owner_sessions)").all<{ name: string }>();
    expect(sessionColumns.results.map((column) => column.name)).toContain("spotify_account_id");
    expect(sessionColumns.results.map((column) => column.name)).not.toContain("spotify_user_id");
  });

  it("reroutes an in-flight rebuild through Never identity resolution", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rebuild_jobs (singleton, generation, status, phase, owner_user_id, cursor, work_key, revision, lease_until, retry_at, retry_count, next_read_at, dispatch_pending, started_at, updated_at) VALUES (1, 'in-flight', 'active', 'album_tracks', 'verified-owner', 'cursor', ?, 7, 9999999999999, 9999999999999, 3, 9999999999999, 0, 1, 1)",
      ).bind(artistId),
      env.DB.prepare("INSERT INTO rebuild_seed_artists (generation, spotify_id, status) VALUES ('in-flight', ?, 'catalogued')").bind(artistId),
      env.DB.prepare("INSERT INTO rebuild_album_queue (generation, spotify_id, bucket_artist_id, album_name) VALUES ('in-flight', 'album-in-flight', ?, 'Album')").bind(artistId),
      env.DB.prepare("INSERT INTO rebuild_enrich_queue (generation, seq, bucket_artist_id, track_ids_json) VALUES ('in-flight', 1, ?, '[]')").bind(artistId),
      env.DB.prepare("INSERT INTO rebuild_playlist_queue (generation, spotify_id) VALUES ('in-flight', 'playlist-in-flight')"),
      env.DB.prepare("INSERT INTO rebuild_known_recordings (generation, recording_key) VALUES ('in-flight', 'spotify:known')"),
      env.DB.prepare("INSERT INTO recordings (generation, recording_key, spotify_id, isrc, title, album_name, release_date, image_url, spotify_url, artists_json, bucket_artist_id) VALUES ('in-flight', 'spotify:staged', 'staged', NULL, 'Staged', 'Album', NULL, NULL, 'https://open.spotify.com/track/staged', '[]', ?)").bind(artistId),
    ]);

    await run(restartReroutedRebuildMigration);
    await run(preservePreflightGateMigration);

    expect(await env.DB.prepare("SELECT phase, cursor, work_key, revision, lease_until, retry_at, retry_count, next_read_at, dispatch_pending FROM rebuild_jobs WHERE singleton = 1").first()).toEqual({
      phase: "never_identities",
      cursor: null,
      work_key: null,
      revision: 9,
      lease_until: null,
      retry_at: null,
      retry_count: 0,
      next_read_at: 0,
      dispatch_pending: 1,
    });
    for (const table of ["rebuild_seed_artists", "rebuild_album_queue", "rebuild_enrich_queue", "rebuild_playlist_queue", "rebuild_known_recordings"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE generation = 'in-flight'`).first<{ count: number }>()).toEqual({ count: 0 });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recordings WHERE generation = 'in-flight'").first<{ count: number }>()).toEqual({ count: 1 });
    await env.DB.prepare("DELETE FROM rebuild_jobs").run();
  });

  it("keeps an unverified in-flight job behind preflight", async () => {
    await env.DB.prepare(
      "INSERT INTO rebuild_jobs (singleton, generation, status, phase, owner_user_id, cursor, work_key, revision, dispatch_pending, started_at, updated_at) VALUES (1, 'unverified', 'active', 'preflight', NULL, NULL, NULL, 3, 0, 1, 1)",
    ).run();

    await run(restartReroutedRebuildMigration);
    await run(preservePreflightGateMigration);

    expect(await env.DB.prepare("SELECT phase, owner_user_id, revision, dispatch_pending FROM rebuild_jobs WHERE singleton = 1").first()).toEqual({
      phase: "preflight",
      owner_user_id: null,
      revision: 5,
      dispatch_pending: 1,
    });
    await env.DB.prepare("DELETE FROM rebuild_jobs").run();
  });

  it("backfills a canonical Never alias and rematerializes an already-upgraded live shelf", async () => {
    const generation = "upgraded-live";
    const canonicalKey = "isrc:USABC2100001";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO recording_generations (generation, promoted_at) VALUES (?, 2)").bind(generation),
      env.DB.prepare("INSERT INTO recordings (generation, recording_key, spotify_id, isrc, title, album_name, release_date, image_url, spotify_url, artists_json, bucket_artist_id) VALUES (?, ?, ?, 'USABC2100001', 'Never upgraded', 'Album', '2020-01-01', NULL, ?, '[]', ?)").bind(generation, canonicalKey, neverKeepTrack, `https://open.spotify.com/track/${neverKeepTrack}`, artistId),
      env.DB.prepare("INSERT INTO recommendation_slots (generation, bucket_artist_id, track_slot, recording_key) VALUES (?, ?, 1, ?)").bind(generation, artistId, canonicalKey),
      env.DB.prepare("INSERT INTO recommendation_buckets (generation, bucket_slot, bucket_artist_id, track_count) VALUES (?, 1, ?, 1)").bind(generation, artistId),
      env.DB.prepare("UPDATE refresh_state SET live_generation = ?, candidate_count = 1, live_bucket_count = 1 WHERE singleton = 1").bind(generation),
    ]);

    await run(legacyNeverIdentityMigration);

    expect(await env.DB.prepare("SELECT isrc, spotify_id FROM never_recordings WHERE recording_key = ?").bind(canonicalKey).first()).toEqual({ isrc: "USABC2100001", spotify_id: neverKeepTrack });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_slots WHERE generation = ?").bind(generation).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT candidate_count, live_bucket_count FROM refresh_state WHERE singleton = 1").first()).toEqual({ candidate_count: 0, live_bucket_count: 0 });
  });
  it("adds resumable waits and incremental discovery without changing existing work or exclusions", async () => {
    await env.DB.prepare("INSERT INTO rebuild_jobs (singleton, generation, status, phase, cursor, revision, retry_at, started_at, updated_at) VALUES (1, 'quota-stopped', 'failed', 'enrich', 'saved-cursor', 17, 12345, 1, 2)").run();
    const job = await env.DB.prepare("SELECT * FROM rebuild_jobs").first();
    const shelf = await env.DB.prepare("SELECT * FROM refresh_state").first();
    const slots = await env.DB.prepare("SELECT * FROM recommendation_slots").all();
    const exclusions = await env.DB.prepare("SELECT * FROM never_recordings").all();
    await run(resumableQuotaMigration);
    const upgraded = await env.DB.prepare("SELECT * FROM rebuild_jobs").first();
    expect(upgraded).toEqual({ ...job, wait_reason: null });
    expect(await env.DB.prepare("SELECT * FROM refresh_state").first()).toEqual(shelf);
    expect((await env.DB.prepare("SELECT * FROM recommendation_slots").all()).results).toEqual(slots.results);
    expect((await env.DB.prepare("SELECT * FROM never_recordings").all()).results).toEqual(exclusions.results);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM spotify_track_cache").first()).toEqual({ count: 0 });
    await env.DB.prepare("UPDATE rebuild_jobs SET status = 'active', phase = 'known_playlist_items', cursor = 'job-cursor', revision = 42, lease_until = 9999, retry_at = 8888, next_read_at = 7777").run();
    await env.DB.prepare("INSERT INTO rebuild_playlist_queue (generation, spotify_id, cursor) VALUES ('quota-stopped', 'playlist', 'page-cursor')").run();
    await env.DB.prepare("INSERT INTO rebuild_known_recordings VALUES ('quota-stopped', ?)").bind(`spotify:${keepTrack}`).run();
    const activeJob = await env.DB.prepare("SELECT * FROM rebuild_jobs").first();
    const playlist = await env.DB.prepare("SELECT * FROM rebuild_playlist_queue").first();
    const liveShelf = await env.DB.prepare("SELECT * FROM refresh_state").first();
    await run(incrementalDiscoveryMigration);
    expect(await env.DB.prepare("SELECT * FROM rebuild_jobs").first()).toEqual({ ...activeJob, pace_multiplier: 1, pace_successes: 0 });
    expect(await env.DB.prepare("SELECT * FROM rebuild_playlist_queue").first()).toEqual({ ...playlist, snapshot_id: null, cache_context: null });
    expect(await env.DB.prepare("SELECT * FROM refresh_state").first()).toEqual(liveShelf);
    expect(await env.DB.prepare("SELECT * FROM rebuild_known_tracks WHERE generation = 'quota-stopped'").first()).toEqual({ generation: 'quota-stopped', spotify_id: keepTrack, recording_key: `spotify:${keepTrack}` });
    await env.DB.prepare("UPDATE rebuild_jobs SET wait_reason = 'quota'").run();
    const beforeProgress = await env.DB.prepare("SELECT generation, revision, cursor, phase, lease_until, retry_at, next_read_at FROM rebuild_jobs").first();
    await run(refreshProgressMigration);
    await run(identityAvailabilityMigration);
    await run(operationalHistoryMigration);
    await env.DB.prepare("INSERT INTO rebuild_seed_artists(generation,spotify_id) VALUES ('quota-stopped','current-artist'),('quota-stopped','later-artist')").run();
    await env.DB.prepare("UPDATE rebuild_jobs SET work_key='current-artist'").run();
    await run(progressivePublicationMigration);
    expect((await env.DB.prepare("SELECT spotify_id,admitted FROM rebuild_seed_artists ORDER BY spotify_id").all()).results).toEqual([
      { spotify_id: 'current-artist', admitted: 1 }, { spotify_id: 'later-artist', admitted: 0 },
    ]);
    expect(await env.DB.prepare("SELECT priority_new_artists FROM rebuild_jobs").first()).toEqual({ priority_new_artists: 1 });
    expect(await env.DB.prepare("SELECT fair_scheduler FROM rebuild_jobs").first()).toEqual({ fair_scheduler: 1 });
    expect(await env.DB.prepare("SELECT generation FROM refresh_history").first()).toEqual({ generation: "quota-stopped" });
    expect(await env.DB.prepare("SELECT generation, revision, cursor, phase, lease_until, retry_at, next_read_at FROM rebuild_jobs").first()).toEqual(beforeProgress);
    const progress = await env.DB.prepare("SELECT progress_json, progress_partial, progress_started_at, request_counts_json, retry_source FROM rebuild_jobs").first<{ progress_json: string; progress_partial: number; progress_started_at: number; request_counts_json: string; retry_source: string | null }>();
    expect(progress?.progress_partial).toBe(1);
    expect(progress?.progress_started_at).toBeGreaterThan(0);
    expect(JSON.parse(progress!.progress_json)).toMatchObject({ playlists: 1, seedArtists: 0, tracksDiscovered: 0 });
    expect(progress?.request_counts_json).toBe('{}');
    expect(progress?.retry_source).toBeNull();
    expect(await env.DB.prepare("SELECT quota_attempts, quota_wait_started_at FROM rebuild_jobs").first()).toEqual({ quota_attempts: 1, quota_wait_started_at: 2 });

  });


});
