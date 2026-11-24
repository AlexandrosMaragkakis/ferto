import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, evictDurableObject, getQueueResult, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { StorageControlState, type ControlStore, STORAGE_PAUSE_BYTES, STORAGE_RESUME_BYTES } from "../src/storage-control-state";
import { checkCapacity, storageControl } from "../src/capacity";
import { storageFailure } from "../src/storage-failure";
import { reconcilePendingSaves } from "../src/owner-save";
import { scheduledTick, startOrWakeRebuild, WATCHDOG_CRON_EXPRESSION } from "../src/rebuild";
import { hmacSha256 } from "../src/security";
import { applyCurrentSchema } from "./current-schema";

const track = "1234567890123456789012";
const other = "abcdefghijklmnopqrstuv";
const key = "isrc:USABC2100001";
const operation = "synthetic-save-operation-0001";
const origin = "https://capacity.example.com";
const fullError = () => new Error("D1_ERROR: Exceeded maximum DB size.");

function model() {
  const values = new Map<string, unknown>();
  const store: ControlStore = {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: (key, value) => { values.set(key, structuredClone(value)); },
    delete: key => values.delete(key),
    list: <T>(options?: { prefix?: string; limit?: number }) => new Map([...values]
      .filter(([key]) => key.startsWith(options?.prefix ?? "")).sort(([a], [b]) => a.localeCompare(b)).slice(0, options?.limit ?? Infinity)) as Map<string, T>,
  };
  return { state: new StorageControlState(store), store };
}

describe("durable capacity state", () => {
  it("warns, pauses, uses hysteresis, rejects stale observations and survives reinstantiation", () => {
    const { state, store } = model();
    expect(state.observeCapacity(375_000_000, 10).capacity).toMatchObject({ warning: true, paused: false });
    expect(state.observeCapacity(STORAGE_PAUSE_BYTES, 20).capacity.paused).toBe(true);
    expect(state.observeCapacity(399_000_000, 30).capacity.paused).toBe(true);
    expect(state.observeCapacity(10, 5).capacity.bytes).toBe(399_000_000);
    expect(new StorageControlState(store).snapshot().capacity.paused).toBe(true);
    expect(state.observeCapacity(STORAGE_RESUME_BYTES, 40).capacity.paused).toBe(false);
    expect(() => state.observeCapacity(NaN)).toThrow();
  });

  it("bounds observed daily usage and resets quota pauses only on the next UTC day", () => {
    const { state } = model();
    const now = Date.parse("2026-11-24T23:59:00Z");
    state.recordUsage(100, 69_999, now);
    expect(state.snapshot(now).capacity.paused).toBe(false);
    state.recordUsage(0, 1, now);
    expect(state.snapshot(now).capacity.reason).toBe("daily_writes");
    expect(state.snapshot(now + 120000).capacity.paused).toBe(false);
    state.noteFailure("daily_reads", now);
    expect(state.snapshot(now).capacity.reason).toBe("daily_reads");
    expect(state.snapshot(now + 120000).capacity.paused).toBe(false);
    expect(() => state.recordUsage(-1, 0)).toThrow();
  });

  it("preserves client and global limits without letting denied clients spend the global budget", () => {
    const { state } = model();
    for (let i = 0; i < 60; i++) expect(state.admit("draw", "a".repeat(64), 1)).toBe(true);
    for (let i = 0; i < 100; i++) expect(state.admit("draw", "a".repeat(64), 1)).toBe(false);
    for (let client = 0; client < 9; client++) for (let i = 0; i < 60; i++) expect(state.admit("draw", client.toString(16).padStart(64, "0"), 1)).toBe(true);
    expect(state.admit("draw", "f".repeat(64), 1)).toBe(false);
    expect(state.admit("draw", "a".repeat(64), 60002)).toBe(true);
    for (let i = 0; i < 5; i++) expect(state.admit("login", "a".repeat(64), 1)).toBe(true);
    expect(state.admit("login", "a".repeat(64), 1)).toBe(false);
  });

  it("bounds pending intents, protects confirmed receipts and enforces the save lease", () => {
    const { state, store } = model();
    expect(state.beginSave(track, key, operation, 1).kind).toBe("started");
    expect(state.beginSave(track, key, operation, 2).kind).toBe("busy");
    state.confirmSave(track, operation, 3);
    state.expireIntents(10 * 86400000);
    expect(new StorageControlState(store).beginSave(track, key, operation, 20).kind).toBe("confirmed");
    for (let i = 0; i < 31; i++) expect(state.beginSave(String(i).padStart(22, "0"), key, operation, 4).kind).toBe("started");
    expect(state.beginSave(other, key, operation, 5).kind).toBe("full");
    state.expireIntents(10 * 86400000);
    expect(state.saves()).toHaveLength(1);
    state.finishSave(track, "different-operation"); expect(state.saves()).toHaveLength(1);
    state.finishSave(track, operation); expect(state.saves()).toHaveLength(0);
  });

  it.each([
    ["D1_ERROR: Exceeded maximum DB size.", "storage"],
    ["Your account has exceeded D1's maximum account storage limit", "storage"],
    ["D1_ERROR: database or disk is full: SQLITE_FULL", "storage"],
    ["Your account has exceeded D1's free tier daily row read limit.", "daily_reads"],
    ["Your account has exceeded D1's free tier daily row write limit.", "daily_writes"],
    ["UNIQUE constraint failed: recordings.generation", null],
    ["Spotify QUOTA_EXCEEDED", null],
  ])("classifies %s without treating unrelated failures as capacity", (message, expected) => {
    expect(storageFailure(new Error(message))).toBe(expected);
  });
});

/** Reject mutations while preserving real D1 reads/transactions. This models
 * provider write failures, not Cloudflare's physical page allocator. */
function rejectWrites(database: D1Database, error = fullError): D1Database {
  const originals = new WeakMap<D1PreparedStatement, { statement: D1PreparedStatement; sql: string }>();
  const guard = (sql: string) => { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) throw error(); };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), sql),
      all: async <T>() => { guard(sql); return statement.all<T>(); },
      run: async <T>() => { guard(sql); return statement.run<T>(); },
      first: async <T>(column?: string) => { guard(sql); return column === undefined ? statement.first<T>() : statement.first<T>(column); },
      raw: statement.raw.bind(statement),
    };
    originals.set(wrapped, { statement, sql }); return wrapped;
  };
  return new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async <T>(batch: D1PreparedStatement[]) => target.batch<T>(batch.map(wrapped => {
      const item = originals.get(wrapped)!; guard(item.sql); return item.statement;
    }));
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

const post = () => new Request(origin + "/api/owner/like", { method: "POST", headers: {
  Origin: origin, Cookie: "ferto_session=capacity-owner; ferto_csrf=csrf", "X-CSRF-Token": "csrf", "Content-Type": "application/json",
}, body: JSON.stringify({ trackId: track }) });

function failControl(method: string): Env["STORAGE_CONTROL"] {
  return new Proxy(env.STORAGE_CONTROL, { get(target, property) {
    if (property === "getByName") return (name: string) => {
      const stub = target.getByName(name);
      return new Proxy(stub, { get(object, member) {
        if (member === method) return async () => { throw new Error("Synthetic control service outage"); };
        const value = Reflect.get(object, member, object) as unknown; return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, object, args) : value;
      } });
    };
    const value = Reflect.get(target, property, target) as unknown; return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
  } });
}

describe("storage safeguards on the actual Worker and durable binding", () => {
  beforeAll(() => applyCurrentSchema(env.DB));
  beforeEach(async () => {
    await env.DB.batch(["recommendation_slots", "recommendation_buckets", "recordings", "recording_generations", "rebuild_known_recordings", "rebuild_jobs", "owner_sessions", "never_recordings"].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO recording_generations VALUES ('capacity-live',1)"),
      env.DB.prepare(`INSERT INTO recordings(generation,recording_key,spotify_id,isrc,title,album_name,spotify_url,artists_json,bucket_artist_id)
        VALUES ('capacity-live',?,?,'USABC2100001','Fixture song','Fixture album','https://open.spotify.com/track/1234567890123456789012','[]','fixture')`).bind(key, track),
      env.DB.prepare("INSERT INTO recommendation_slots VALUES ('capacity-live','fixture',1,?)").bind(key),
      env.DB.prepare("INSERT INTO recommendation_buckets VALUES ('capacity-live',1,'fixture',1)"),
      env.DB.prepare("UPDATE refresh_state SET live_generation='capacity-live',candidate_count=1,live_bucket_count=1 WHERE singleton=1"),
      env.DB.prepare("INSERT INTO owner_sessions(session_hash,spotify_account_id,expires_at,created_at) VALUES (?,?,?,1)")
        .bind(await hmacSha256("capacity-owner", env.SESSION_SECRET), env.OWNER_SPOTIFY_ID, Date.now() + 60000),
    ]);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("keeps public discovery working with shared rate limits when D1 rejects every mutation", async () => {
    const testEnv = { ...env, APP_ORIGIN: origin, DB: rejectWrites(env.DB) };
    const draw = () => worker.fetch(new Request(origin + "/api/recommendation", { headers: { "CF-Connecting-IP": "192.0.2.9" } }), testEnv);
    const response = await draw(); expect(response.status).toBe(200);
    expect((await response.json<{ recommendation: { spotify_id: string } }>()).recommendation.spotify_id).toBe(track);
    for (let i = 1; i < 60; i++) expect((await draw()).status).toBe(200);
    expect((await draw()).status).toBe(429);
  });

  it("persists capacity and strict concurrent budgets across a real DO eviction", async () => {
    const control = storageControl(env);
    await control.observeCapacity(STORAGE_PAUSE_BYTES, Date.now());
    const admitted = await Promise.all(Array.from({ length: 65 }, () => control.admit("draw", "a".repeat(64))));
    expect(admitted.filter(Boolean)).toHaveLength(60);
    await evictDurableObject(control);
    expect((await control.snapshot()).capacity.paused).toBe(true);
    expect(await control.admit("draw", "a".repeat(64))).toBe(false);
  });

  it("fails closed when shared request protection is unavailable", async () => {
    const response = await worker.fetch(new Request(origin + "/api/recommendation", { headers: { "CF-Connecting-IP": "192.0.2.10" } }),
      { ...env, APP_ORIGIN: origin, STORAGE_CONTROL: failControl("admit") });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Request protection") });
  });

  it("does not issue a provider save when its durable intent cannot be stored", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ access_token: "fixture-access" }));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await worker.fetch(post(), { ...env, APP_ORIGIN: origin, STORAGE_CONTROL: failControl("beginSave") });
    expect(response.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://accounts.spotify.com/api/token");
  });

  it("reports a partial Add and reconciles it without repeating the provider write", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "fixture-access", expires_in: 60, scope: "user-library-modify" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const failingEnv = { ...env, APP_ORIGIN: origin, DB: rejectWrites(env.DB) };
    const response = await worker.fetch(post(), failingEnv);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: false, spotifySaved: true, pending: true });
    expect((await storageControl(env).saves())[0]).toMatchObject({ trackId: track, state: "confirmed" });
    expect((await worker.fetch(post(), failingEnv)).status).toBe(202);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await reconcilePendingSaves(env);
    expect(await storageControl(env).saves()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT candidate_count FROM refresh_state").first("candidate_count")).toBe(0);
    expect(await env.DB.prepare("SELECT recording_key FROM rebuild_known_recordings").first("recording_key")).toBe(key);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not automatically replay an uncertain provider save", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "fixture-access" })).mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchSpy);
    const testEnv = { ...env, APP_ORIGIN: origin };
    expect((await worker.fetch(post(), testEnv)).status).toBe(502);
    expect((await storageControl(env).saves())[0].state).toBe("intent");
    await reconcilePendingSaves(env);
    expect((await worker.fetch(post(), testEnv)).status).toBe(409);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves a durable intent if confirmation persistence fails after Spotify saves", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "fixture-access" })).mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await worker.fetch(post(), { ...env, APP_ORIGIN: origin, STORAGE_CONTROL: failControl("confirmSave") });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ spotifySaved: true, pending: true, ok: false });
    expect((await storageControl(env).saves())[0].state).toBe("intent");
    await reconcilePendingSaves(env);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM rebuild_known_recordings").first("n")).toBe(0);
  });

  it("never falsely acknowledges an exclusion when D1 is full", async () => {
    const request = new Request(origin + "/api/owner/never-again", post());
    const response = await worker.fetch(request, { ...env, APP_ORIGIN: origin, DB: rejectWrites(env.DB) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "storage" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM never_recordings").first("n")).toBe(0);
    expect((await storageControl(env).snapshot()).capacity.paused).toBe(true);
  });

  it("honors a persisted growth pause for manual, weekly, watchdog and duplicate queue wakes", async () => {
    await env.DB.prepare("INSERT INTO rebuild_jobs(singleton,generation,status,phase,revision,started_at,updated_at) VALUES (1,'capacity-job','active','enrich',4,1,1)").run();
    await storageControl(env).observeCapacity(STORAGE_PAUSE_BYTES, Date.now());
    const send = vi.fn().mockResolvedValue({});
    const database = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (sql === "SELECT 1 AS capacity_probe") return new Proxy(statement, { get(prepared, member) {
          if (member === "all") return async () => {
            const result = await prepared.all();
            return { ...result, meta: { ...result.meta, size_after: STORAGE_PAUSE_BYTES } };
          };
          const value = Reflect.get(prepared, member, prepared) as unknown; return typeof value === "function" ? value.bind(prepared) : value;
        } });
        return statement;
      };
      const value = Reflect.get(target, property, target) as unknown; return typeof value === "function" ? value.bind(target) : value;
    } });
    const testEnv = { ...env, DB: database, REFRESH_QUEUE: { ...env.REFRESH_QUEUE, send } };
    expect((await startOrWakeRebuild(testEnv)).state).toBe("paused");
    await scheduledTick(testEnv, Date.now(), "0 3 * * SUN");
    await scheduledTick(testEnv, Date.now(), WATCHDOG_CRON_EXPRESSION);
    const batch = createMessageBatch("ferto-refresh", [{ id: "capacity-message", timestamp: new Date(), attempts: 1, body: { generation: "capacity-job", revision: 4 } }]);
    await worker.queue(batch, testEnv);
    expect((await getQueueResult(batch, createExecutionContext())).explicitAcks).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT revision FROM rebuild_jobs").first("revision")).toBe(4);
  });

  it("requires a successful write probe before resuming after a storage error", async () => {
    await storageControl(env).noteFailure("storage");
    const failing = { ...env, DB: rejectWrites(env.DB) };
    expect((await checkCapacity(failing, true)).capacity.paused).toBe(true);
    expect((await checkCapacity(env, true)).capacity.paused).toBe(false);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM request_budgets WHERE budget_key='capacity:probe'").first("n")).toBe(0);
  });

  it("acknowledges a capacity-failed delivery and relies on the watchdog instead of a retry storm", async () => {
    await env.DB.prepare("INSERT INTO rebuild_jobs(singleton,generation,status,phase,revision,started_at,updated_at) VALUES (1,'failed-write','active','enrich',2,1,1)").run();
    const batch = createMessageBatch("ferto-refresh", [{ id: "failed-write", timestamp: new Date(), attempts: 1, body: { generation: "failed-write", revision: 2 } }]);
    await worker.queue(batch, { ...env, DB: rejectWrites(env.DB) });
    expect((await getQueueResult(batch, createExecutionContext())).explicitAcks).toHaveLength(1);
    expect((await storageControl(env).snapshot()).capacity.paused).toBe(true);
    expect(await env.DB.prepare("SELECT revision FROM rebuild_jobs").first("revision")).toBe(2);
  });
});
