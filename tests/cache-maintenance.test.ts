import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CACHE_CLEANUP_BATCH_SIZE, cleanupExpiredCaches } from "../src/cache-maintenance";
import { readAlbumPage } from "../src/catalogue-cache";
import { startRebuild, WATCHDOG_CRON_EXPRESSION } from "../src/rebuild";
import worker from "../src/worker";
import { applyCurrentSchema } from "./current-schema";

const cacheTables = ["spotify_track_cache", "recording_identity_cache", "track_availability", "album_track_pages"] as const;
const protectedTables = ["recordings", "recording_generations", "recommendation_slots", "recommendation_buckets",
  "never_recordings", "rebuild_jobs", "rebuild_known_recordings", "rebuild_known_tracks", "rebuild_enrich_queue", "owner_sessions", "refresh_state"];
const id = (index: number) => String(index).padStart(22, "0");

beforeAll(async () => { await applyCurrentSchema(env.DB); });
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_cache_cleanup").run();
  await env.DB.batch([...cacheTables, "album_availability_pages", ...protectedTables.filter(table => table !== "refresh_state")]
    .map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  await env.DB.prepare("UPDATE refresh_state SET live_generation=NULL,candidate_count=0,live_bucket_count=0 WHERE singleton=1").run();
});

async function seedCaches(expiries: number[], context = "fixture") {
  const rows = JSON.stringify(expiries.map((expires, index) => ({ id: id(index), expires })));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO spotify_track_cache SELECT ?, 'GR', json_extract(value,'$.id'), '{}', json_extract(value,'$.expires') FROM json_each(?)`).bind(context, rows),
    env.DB.prepare(`INSERT INTO recording_identity_cache SELECT ?, 'GR', json_extract(value,'$.id'), '{}', json_extract(value,'$.expires') FROM json_each(?)`).bind(context, rows),
    env.DB.prepare(`INSERT INTO track_availability SELECT ?, 'GR', json_extract(value,'$.id'), json_extract(value,'$.id'), '{}', json_extract(value,'$.expires') FROM json_each(?)`).bind(context, rows),
    env.DB.prepare(`INSERT INTO album_track_pages SELECT ?, json_extract(value,'$.id'), 'start', '[]', NULL, json_extract(value,'$.expires') FROM json_each(?)`).bind(context, rows),
  ]);
}

async function counts() {
  return Promise.all(cacheTables.map(table => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n")));
}

async function preservedState() {
  return Promise.all(protectedTables.map(table => env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().then(result => result.results)));
}

function queueEnv() {
  const send = vi.fn().mockResolvedValue({});
  const queue = { send, sendBatch: vi.fn().mockResolvedValue({}), metrics: vi.fn().mockResolvedValue({}) } as Queue;
  return { testEnv: { ...env, REFRESH_QUEUE: queue }, send };
}

async function watchdog(testEnv: Env) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: WATCHDOG_CRON_EXPRESSION,
    scheduledTime: Date.UTC(2026, 10, 24, 12, 15) }), testEnv, ctx);
  await waitOnExecutionContext(ctx);
}

async function failCleanup() {
  await env.DB.prepare(`CREATE TRIGGER fail_cache_cleanup BEFORE DELETE ON recording_identity_cache
    BEGIN SELECT RAISE(ABORT, 'sensitive-cache-failure'); END`).run();
}

it("bounds a large backlog, drains it over later ticks and preserves exact TTL boundaries", async () => {
  const timestamp = Date.now();
  const expired = CACHE_CLEANUP_BATCH_SIZE * 2 + 5;
  await seedCaches([...Array(expired - 1).fill(timestamp - 1), timestamp, timestamp + 60000]);
  const first = await cleanupExpiredCaches(env, timestamp);
  expect(first.deleted.map(table => table.rows)).toEqual(cacheTables.map(() => CACHE_CLEANUP_BATCH_SIZE));
  expect(await counts()).toEqual(cacheTables.map(() => expired + 1 - CACHE_CLEANUP_BATCH_SIZE));
  // Concurrent/duplicate invocations each retain their own fixed bound and
  // cannot select then delete the same stale candidate after another commit.
  await Promise.all([cleanupExpiredCaches(env, timestamp), cleanupExpiredCaches(env, timestamp)]);
  expect(await counts()).toEqual(cacheTables.map(() => 1));
  const empty = await cleanupExpiredCaches(env, timestamp);
  expect(empty.deleted.every(table => table.rows === 0)).toBe(true);
  for (const table of cacheTables) {
    expect(await env.DB.prepare(`SELECT expires_at FROM ${table}`).first<number>("expires_at")).toBe(timestamp + 60000);
  }
});

it("keeps read and index-write costs bounded with thousands of fresh rows", async () => {
  const timestamp = Date.now();
  await seedCaches([...Array(3000).fill(timestamp + 60000), ...Array(64).fill(timestamp - 1)]);
  const report = await cleanupExpiredCaches(env, timestamp);
  expect(report.deleted.map(table => table.rows)).toEqual([32, 32, 32, 32]);
  // Measure the real binding metadata. Each deleted row also has a primary-key
  // and expiry index; a growing fresh catalogue must not cause a table scan.
  expect(report.rowsRead).toBeLessThanOrEqual(512);
  expect(report.rowsWritten).toBeLessThanOrEqual(384);
  expect(report.rowsWritten).toBeGreaterThanOrEqual(128);
});

it("rechecks expiry after a concurrent cache refresh", async () => {
  const timestamp = Date.now();
  await seedCaches([timestamp - 1]);
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (batch: D1PreparedStatement[]) => {
      await target.prepare("UPDATE spotify_track_cache SET expires_at=?").bind(timestamp + 60000).run();
      return target.batch(batch);
    };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await cleanupExpiredCaches({ DB: database }, timestamp);
  expect(await counts()).toEqual([1, 0, 0, 0]);
});

it("preserves expired availability markers that invalidate fresh discovery pages", async () => {
  const timestamp = Date.now();
  await seedCaches([timestamp + 60000], "availability");
  await env.DB.prepare("INSERT INTO album_availability_pages VALUES ('availability',?,'start',?)").bind(id(0), timestamp - 1).run();
  expect(await readAlbumPage(env, "availability", id(0), "start")).toBeNull();
  await cleanupExpiredCaches(env, timestamp);
  expect(await counts()).toEqual([1, 1, 1, 1]);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM album_availability_pages").first<number>("n")).toBe(1);
  expect(await readAlbumPage(env, "availability", id(0), "start")).toBeNull();
});

it("preserves catalogue history, permanent decisions, active work and stale-card identities", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO recording_generations VALUES ('live',1),('older-live',0)"),
    env.DB.prepare(`INSERT INTO recordings(generation,recording_key,spotify_id,isrc,title,album_name,spotify_url,artists_json,bucket_artist_id)
      SELECT value,'isrc:USABC2100001',?,'USABC2100001','Fixture song','Fixture album',?,'[]','fixture-artist'
      FROM json_each('["live","older-live","active"]')`).bind(id(1), `https://open.spotify.com/track/${id(1)}`),
    env.DB.prepare("INSERT INTO recommendation_buckets VALUES ('live',1,'fixture-artist',1)"),
    env.DB.prepare("INSERT INTO recommendation_slots VALUES ('live','fixture-artist',1,'isrc:USABC2100001')"),
    env.DB.prepare("INSERT INTO never_recordings VALUES ('isrc:USABC2100002','USABC2100002',?,1)").bind(id(2)),
    env.DB.prepare(`INSERT INTO rebuild_jobs(singleton,generation,status,phase,cursor,revision,retry_at,started_at,updated_at)
      VALUES (1,'active','active','enrich','saved-cursor',9,?,1,1)`).bind(Date.now() + 86400000),
    env.DB.prepare("INSERT INTO rebuild_known_recordings VALUES ('active','isrc:USABC2100002')"),
    env.DB.prepare("INSERT INTO rebuild_known_tracks VALUES ('active',?,'isrc:USABC2100002')").bind(id(2)),
    env.DB.prepare("INSERT INTO rebuild_enrich_queue VALUES ('active',1,'fixture-artist',?)").bind(JSON.stringify([id(3)])),
    env.DB.prepare("INSERT INTO owner_sessions(session_hash,spotify_account_id,expires_at,created_at) VALUES ('fixture','owner',?,1)").bind(Date.now() + 60000),
    env.DB.prepare("UPDATE refresh_state SET live_generation='live',candidate_count=1,live_bucket_count=1 WHERE singleton=1"),
  ]);
  await seedCaches([0, Date.now() + 60000]);
  const before = await preservedState();
  await cleanupExpiredCaches(env);
  expect(await counts()).toEqual([1, 1, 1, 1]);
  expect(await preservedState()).toEqual(before);
});

it("rolls back earlier deletions when a later table fails, then recovers on a later tick", async () => {
  await seedCaches([0, 0]);
  await failCleanup();
  await expect(cleanupExpiredCaches(env)).rejects.toThrow();
  expect(await counts()).toEqual([2, 2, 2, 2]);
  await env.DB.prepare("DROP TRIGGER fail_cache_cleanup").run();
  await cleanupExpiredCaches(env);
  expect(await counts()).toEqual([0, 0, 0, 0]);
});

it.each(["idle", "failed", "quota-waiting"])("cleans through the scheduled handler while refresh work is %s", async state => {
  await seedCaches([0]);
  if (state !== "idle") {
    await env.DB.prepare(`INSERT INTO rebuild_jobs(singleton,generation,status,phase,revision,retry_at,started_at,updated_at)
      VALUES (1,'waiting',?,'enrich',7,?,1,1)`)
      .bind(state === "failed" ? "failed" : "active", Date.now() + 86400000).run();
  }
  const before = await env.DB.prepare("SELECT * FROM rebuild_jobs").all();
  const { testEnv, send } = queueEnv();
  vi.stubGlobal("fetch", vi.fn());
  await watchdog(testEnv);
  expect(await counts()).toEqual([0, 0, 0, 0]);
  expect((await env.DB.prepare("SELECT * FROM rebuild_jobs").all()).results).toEqual(before.results);
  expect(send).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not let a cleanup failure prevent overdue watchdog recovery or leak exception details", async () => {
  await seedCaches([0]);
  await env.DB.prepare(`INSERT INTO rebuild_jobs(singleton,generation,status,phase,revision,started_at,updated_at)
    VALUES (1,'overdue','active','enrich',3,1,1)`).run();
  await failCleanup();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { testEnv, send } = queueEnv();
  vi.stubGlobal("fetch", vi.fn());
  await watchdog(testEnv);
  expect(await counts()).toEqual([1, 1, 1, 1]);
  expect(send).toHaveBeenCalledExactlyOnceWith({ generation: "overdue", revision: 3 }, { contentType: "json" });
  expect(error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "expired_cache_cleanup_failed" }));
  expect(fetch).not.toHaveBeenCalled();
});

it("does not bulk-delete the cache backlog when starting a new refresh", async () => {
  const backlog = CACHE_CLEANUP_BATCH_SIZE * 2;
  await seedCaches(Array(backlog).fill(0));
  const { testEnv } = queueEnv();
  await startRebuild(testEnv);
  expect(await counts()).toEqual([backlog, backlog, backlog, backlog]);
  await watchdog(testEnv);
  expect(await counts()).toEqual([32, 32, 32, 32]);
});
