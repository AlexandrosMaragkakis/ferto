import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import demoCatalogue from "../scripts/demo-catalogue.sql?raw";
import packageJsonRaw from "../package.json?raw";
import { statements } from "./statements";

async function run(sql: string): Promise<void> {
  for (const statement of statements(sql)) await env.DB.prepare(statement).run();
}

const migrations = [
  initialMigration,
  stagingMigration,
  incrementalMigration,
  leaseMigration,
  playlistSkipMigration,
  refreshAlgorithmMigration,
  backgroundRefreshMigration,
  spotifyWaitReasonMigration,
  v4Migration,
  identityAndSlotsMigration,
  atomicPoolMigration,
  legacyNeverIdentityMigration,
  neverIdentityChecksMigration,
  restartReroutedRebuildMigration,
  preservePreflightGateMigration,
  resumableQuotaMigration,
  incrementalDiscoveryMigration,
  refreshProgressMigration, identityAvailabilityMigration, operationalHistoryMigration, progressivePublicationMigration,
];

describe("isolated local demo", () => {
  beforeAll(async () => {
    await run(migrations.join("\n"));
  });

  beforeEach(async () => {
    await run(demoCatalogue);
  });

  it("promotes exactly three complete public Spotify recordings", async () => {
    const state = await env.DB.prepare(
      "SELECT live_generation, candidate_count, live_bucket_count, last_outcome, last_error FROM refresh_state WHERE singleton = 1",
    ).first<{ live_generation: string | null; candidate_count: number; live_bucket_count: number; last_outcome: string | null; last_error: string | null }>();
    expect(state).toEqual({ live_generation: "demo-live", candidate_count: 3, live_bucket_count: 3, last_outcome: "promoted", last_error: null });

    const rows = await env.DB.prepare(
      "SELECT spotify_id, isrc, image_url, spotify_url, artists_json, bucket_artist_id FROM recordings WHERE generation = 'demo-live' ORDER BY spotify_id",
    ).all<{ spotify_id: string; isrc: string | null; image_url: string | null; spotify_url: string; artists_json: string; bucket_artist_id: string }>();
    expect(rows.results.map((row) => row.spotify_id)).toEqual([
      "0VjIjW4GlUZAMYd2vXMi3b",
      "4uLU6hMCjMI75M1A2tKUQC",
      "7qiZfU4dY1lWllzX7mPBI3",
    ]);
    for (const row of rows.results) {
      expect(row.isrc).toMatch(/^[A-Z0-9]{12}$/);
      expect(row.image_url).toMatch(/^https:\/\/i\.scdn\.co\/image\//);
      expect(row.spotify_url).toBe(`https://open.spotify.com/track/${row.spotify_id}`);
      const artists = JSON.parse(row.artists_json) as { id: string; name: string }[];
      expect(artists).toHaveLength(1);
      expect(artists[0]?.id).toBe(row.bucket_artist_id);
      expect(artists[0]?.name).toBeTruthy();
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recording_generations WHERE generation = 'demo-live'").first<{ count: number }>()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_slots WHERE generation = 'demo-live'").first<{ count: number }>()).toEqual({ count: 3 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recommendation_buckets WHERE generation = 'demo-live'").first<{ count: number }>()).toEqual({ count: 3 });
  });

  it("resets mutable demo decisions and rebuild work on every preparation", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at) VALUES ('isrc:GBARL9300135', 'GBARL9300135', '4uLU6hMCjMI75M1A2tKUQC', 1)"),
      env.DB.prepare("INSERT INTO rebuild_jobs (singleton, generation, status, phase, started_at, updated_at) VALUES (1, 'abandoned-demo', 'active', 'preflight', 1, 1)"),
      env.DB.prepare("UPDATE refresh_state SET live_generation = NULL, candidate_count = 0, live_bucket_count = 0, last_outcome = 'failed', last_error = 'demo mutation' WHERE singleton = 1"),
    ]);

    await run(demoCatalogue);

    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM never_recordings").first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rebuild_jobs").first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recordings").first<{ count: number }>()).toEqual({ count: 3 });
    expect(await env.DB.prepare("SELECT live_generation, candidate_count, live_bucket_count, last_outcome, last_error FROM refresh_state WHERE singleton = 1").first()).toEqual({
      live_generation: "demo-live",
      candidate_count: 3,
      live_bucket_count: 3,
      last_outcome: "promoted",
      last_error: null,
    });
  });

  it("pins every demo database command to local demo-only persistence", () => {
    const scripts = (JSON.parse(packageJsonRaw) as { scripts: Record<string, string> }).scripts;
    const databaseCommands = [scripts["demo:migrate"], scripts["demo:seed"], scripts.demo];
    for (const command of databaseCommands) {
      expect(command).toContain("--local");
      expect(command).toContain("--persist-to .wrangler/demo-state");
      expect(command).not.toMatch(/--remote\b/);
      expect(command).not.toContain(".wrangler/state ");
    }
    expect(scripts.demo).toContain("--env-file /dev/null");
    expect(scripts.demo).toContain('--ip 127.0.0.1 --port "${FERTO_DEMO_PORT:-8787}"');
    expect(scripts.demo).toContain('--var "APP_ORIGIN:http://127.0.0.1:${FERTO_DEMO_PORT:-8787}"');
    expect(scripts.predemo).toBe("npm run demo:prepare");
    expect(scripts["demo:prepare"]).toContain("npm run build");
    expect(scripts["demo:prepare"]).toContain("npm run demo:migrate");
    expect(scripts["demo:prepare"]).toContain("npm run demo:seed");
  });
});
