import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import worker from "../src/worker";
import { consumeRefreshQueue, nextWeeklyCronAt, scheduledTick, startOrWakeRebuild, statusSnapshot, rebuildRecommendationPool, WATCHDOG_CRON_EXPRESSION, type RefreshMessage, type RefreshPhase } from "../src/rebuild";
import { numericProgress, type RequestUsage } from "../src/rebuild-progress";
import { OWNER_ACCOUNT, SyntheticCatalogue } from "./catalogue";
import { seededRandom, simulationConfig, type SimulationConfig } from "./config";
import { SimulationDatabase, type DatabaseMetrics } from "./database";
import { SimulationQueue, type QueueMetricsReport } from "./queue";
import { SyntheticSpotify, type ApiEndpointMetrics, type ApiMetrics } from "./spotify";

type Job = { generation: string; status: string; phase: RefreshPhase; revision: number; lease_until: number | null; retry_at: number | null; next_read_at: number; progress_json: string; request_counts_json: string };
export type TraceEvent = { event: "delivery" | "cron" | "watchdog" | "crash"; at: string; run: number; phase: string; revision: number; statements: number; requests: number; backlog: number; crashed: boolean };
export type RunReport = { run: number; outcome: string; virtualSeconds: number; candidates: number; expectedCandidates: number; artistsCompleted: number;
  requestAttempts: number; endpoints: Partial<Record<keyof RequestUsage, ApiEndpointMetrics>>; progress: Record<string, number>; recordedRequestAttempts: number;
  firstQuotaCoverage: number | null; firstRecommendationSeconds: number | null;
  firstIncrementalPublicationSeconds: number | null; firstNewArtistSeconds: number | null;
  artistsCompletedAtFirstPublication: number | null; firstQuotaPublishedRecordings: number | null;
  checks: Record<string, boolean>; failures: string[] };
export type SimulationReport = {
  schemaVersion: 1; passed: boolean; config: SimulationConfig; virtualStart: string; virtualEnd: string; virtualDays: number; wallSeconds: number;
  fixture: { artists: number; albums: number; trackAppearances: number; expectedRecordings: number; neverRecordings: number; playlists: number };
  runs: RunReport[]; api: ApiMetrics; database: DatabaseMetrics; queue: QueueMetricsReport;
  unfinishedJob?: { status: string; phase: RefreshPhase; revision: number; retryAt: number | null; leaseUntil: number | null; progress: Record<string, number> };
  injectedCrashes: number; cronWakes: number; watchdogTicks: number; watchdogWakes: number; remainingQueueMessages: number; failure?: string;
  recentEvents: TraceEvent[]; recentApiErrors: SyntheticSpotify["errors"]; recentWorkerEvents: Record<string, unknown>[];
  limitations: string[];
};
export type SimulationOptions = { root: string; onEvent?: (event: TraceEvent) => void };
const EPOCH = Date.UTC(2026, 9, 18, 3);
const totalAttempts = (metrics: ApiMetrics["endpoints"]) => Object.values(metrics).reduce((sum, item) => sum + item.attempts, 0);
function difference(after: ApiMetrics["endpoints"], before: ApiMetrics["endpoints"]): ApiMetrics["endpoints"] {
  return Object.fromEntries(Object.entries(after).map(([endpoint, count]) => [endpoint, Object.fromEntries(Object.entries(count).map(([field, value]) => [field, value - (before[endpoint as keyof RequestUsage]?.[field as keyof ApiEndpointMetrics] ?? 0)]))]));
}

/** Runs sequentially in an isolated Node process: real app code and schema,
 * in-process Spotify/Queue models, file-backed SQLite, and virtual time. */
export async function runSimulation(input: Partial<SimulationConfig>, options: SimulationOptions): Promise<SimulationReport> {
  const config = simulationConfig(input);
  const folder = await mkdtemp(join(tmpdir(), "ferto-simulation-"));
  const database = new SimulationDatabase(join(folder, "catalogue.sqlite"), config.maxStatements);
  const clock = { now: EPOCH };
  const random = seededRandom(config.seed);
  const catalogue = new SyntheticCatalogue(config);
  const queue = new SimulationQueue(() => clock.now, random, config);
  const spotify = new SyntheticSpotify(catalogue, config, () => clock.now, EPOCH);
  const original = { fetch: globalThis.fetch, now: Date.now, random: Math.random, log: console.log, error: console.error };
  const started = performance.now();
  let crashesLeft = config.crashes; let crashes = 0; let cronWakes = 0; let watchdogTicks = 0; let watchdogWakes = 0;
  const recentEvents: TraceEvent[] = [];
  const workerEvents: Record<string, unknown>[] = [];
  const runs: RunReport[] = [];
  const generations: string[] = [];
  const environment: Env = {
    DB: database.binding, REFRESH_QUEUE: queue.binding,
    ASSETS: { fetch: async () => new Response("Assets are outside the refresh simulator", { status: 404 }),
      connect: () => { throw new Error("Simulator blocks asset TCP connections"); } },
    SPOTIFY_CLIENT_ID: "simulator-client", OWNER_SPOTIFY_ID: OWNER_ACCOUNT, APP_ORIGIN: "http://simulator.invalid",
    SPOTIFY_REFRESH_TOKEN: "simulator-refresh-token", SESSION_SECRET: "simulator-session-secret-for-local-tests-only",
  };
  const job = () => database.inspect<Job>("SELECT generation,status,phase,revision,lease_until,retry_at,next_read_at,progress_json,request_counts_json FROM rebuild_jobs WHERE singleton = 1")[0];
  const capture = (...messages: unknown[]) => {
    for (const message of messages) if (typeof message === "string") {
      try { const value: unknown = JSON.parse(message); if (value && typeof value === "object" && !Array.isArray(value)) workerEvents.push(value as Record<string, unknown>); } catch { /* Ignore non-structured library logs. */ }
    }
    if (workerEvents.length > 100) workerEvents.splice(0, workerEvents.length - 100);
  };
  const invoke = async (operation: () => Promise<unknown>, crashAfter: number | null = null): Promise<{ statements: number; requests: number; crashed: boolean }> => {
    database.beginInvocation(crashAfter); spotify.beginInvocation();
    const before = totalAttempts(spotify.metrics.endpoints);
    let statements = 0;
    try { await operation(); }
    catch (error) { if (!database.crashed) throw error; }
    finally { statements = database.endInvocation(); spotify.endInvocation(); }
    const crashed = database.crashed;
    if (crashed) { database.reopen(); crashes += 1; crashesLeft -= 1; }
    if (database.metrics.limitViolations || spotify.metrics.limitViolations) throw new Error("An invocation exceeded its configured resource budget");
    if (spotify.metrics.unexpectedRequests) throw new Error("Production code attempted an unexpected outbound request");
    if (spotify.metrics.earlyRequests) throw new Error("An invocation made a request before Spotify's Retry-After deadline");
    return { statements, requests: totalAttempts(spotify.metrics.endpoints) - before, crashed };
  };
  const emit = (event: TraceEvent) => { recentEvents.push(event); if (recentEvents.length > 100) recentEvents.shift(); options.onEvent?.(event); };
  let failure: string | undefined;
  let unfinishedJob: SimulationReport["unfinishedJob"];
  try {
    const migrations = (await readdir(join(options.root, "migrations"))).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of migrations) database.migrate(await readFile(join(options.root, "migrations", name), "utf8"));
    for (const { track, resolved } of catalogue.never) database.seed("INSERT INTO never_recordings (recording_key,isrc,spotify_id,excluded_at) VALUES (?,?,?,?)",
      resolved ? `isrc:${track.canonical}` : `spotify:${track.requestedId}`, resolved ? track.canonical : null, track.requestedId, EPOCH - 1);
    if (config.initialLiveArtists) {
      const generation = "simulator-existing-shelf";
      generations.push(generation);
      database.seed("INSERT INTO recording_generations VALUES (?,?)", generation, EPOCH - 1);
      for (const [key, track] of catalogue.expected) if (track.artistIndex < config.initialLiveArtists) {
        const body = track.body;
        database.seed(`INSERT INTO recordings(generation,recording_key,spotify_id,isrc,title,album_name,release_date,image_url,spotify_url,artists_json,bucket_artist_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, generation, key, body.id, track.canonical, body.name, body.album.name, body.album.release_date, body.album.images[0]!.url,
          body.external_urls.spotify, JSON.stringify(body.artists), catalogue.artists[track.artistIndex]!.id);
      }
      const counts = await rebuildRecommendationPool(environment, generation);
      database.seed("UPDATE refresh_state SET live_generation=?,candidate_count=?,live_bucket_count=? WHERE singleton=1", generation, counts.candidateCount, counts.bucketCount);
    }
    globalThis.fetch = spotify.fetch; Date.now = () => clock.now; Math.random = random; console.log = capture; console.error = capture;
    for (let run = 1; run <= config.runs; run++) {
      if (run === 2 && config.availabilityChanges) catalogue.changeAvailability();
      if (run > 1) clock.now += config.betweenRunsSeconds * 1000;
      const runStart = clock.now;
      const crashesBefore = crashes;
      const previousRequests = structuredClone(spotify.metrics.endpoints);
      const previousQuotaCount = Object.values(spotify.metrics.endpoints).reduce((sum, endpoint) => sum + endpoint.quota, 0);
      const initialArtistCount = database.inspect<{ count: number }>("SELECT live_bucket_count AS count FROM refresh_state WHERE singleton=1")[0]!.count;
      await invoke(() => startOrWakeRebuild(environment));
      if (config.scheduler === "serial") database.seed("UPDATE rebuild_jobs SET fair_scheduler=0");
      let firstQuotaCoverage: number | null = null; let firstRecommendationSeconds: number | null = null;
      let firstIncrementalPublicationSeconds: number | null = null; let firstNewArtistSeconds: number | null = null;
      let artistsCompletedAtFirstPublication: number | null = null; let firstQuotaPublishedRecordings: number | null = null;
      const generation = job()?.generation;
      if (!generation) throw new Error("Refresh failed to create its job");
      generations.push(generation);
      let nextCron = nextWeeklyCronAt(clock.now);
      // Independently model the deployed quarter-hour maintenance schedule.
      const watchdogInterval = 15 * 60_000;
      let nextWatchdog = (Math.floor(clock.now / watchdogInterval) + 1) * watchdogInterval;
      while (job()) {
        const current = job()!;
        if (current.generation !== generation) throw new Error("An active refresh was replaced instead of resumed");
        if (current.status === "failed") throw new Error(`Refresh failed in ${current.phase}`);
        if (queue.metrics.deliveries >= config.maxDeliveries) throw new Error("Delivery limit reached before completion");
        const maintenanceTime = Math.min(nextCron, nextWatchdog);
        const due = Math.min(queue.peek()?.dueAt ?? Infinity, maintenanceTime);
        if (due - runStart > config.maxVirtualDays * 86_400_000) throw new Error("Virtual-time limit reached before completion");
        clock.now = Math.max(clock.now, due);
        if (maintenanceTime <= (queue.peek()?.dueAt ?? Infinity)) {
          const weekly = nextCron <= nextWatchdog;
          const sendsBefore = queue.metrics.sends;
          const result = await invoke(() => scheduledTick(environment, maintenanceTime, weekly ? undefined : WATCHDOG_CRON_EXPRESSION));
          if (weekly) { cronWakes += 1; nextCron = nextWeeklyCronAt(nextCron); }
          else { watchdogTicks += 1; watchdogWakes += Number(queue.metrics.sends > sendsBefore); nextWatchdog += watchdogInterval; }
          emit({ event: weekly ? "cron" : "watchdog", at: new Date(clock.now).toISOString(), run, phase: current.phase, revision: current.revision, ...result, backlog: queue.size });
          continue;
        }
        const delivery = queue.pop()!;
        if (queue.expired(delivery)) continue;
        queue.metrics.deliveries += 1;
        let acknowledged = false; let retryDelay: number | undefined;
        const message: Message<RefreshMessage> = { id: delivery.id, body: delivery.body, attempts: delivery.attempts, timestamp: new Date(delivery.createdAt),
          ack: () => { if (retryDelay === undefined) acknowledged = true; },
          retry: (options) => { if (!acknowledged && retryDelay === undefined) retryDelay = options?.delaySeconds ?? 30; } };
        const batch: MessageBatch<RefreshMessage> = { queue: "simulator-refresh", messages: [message], metadata: { metrics: { backlogCount: queue.size, backlogBytes: queue.size * 100 } },
          ackAll: () => message.ack(), retryAll: (options) => message.retry(options) };
        const result = await invoke(() => worker.queue(batch, environment), crashesLeft > 0 && current.phase === "enrich" ? 9 : null);
        if (firstIncrementalPublicationSeconds === null && database.inspect("SELECT 1 FROM refresh_publications WHERE generation=? LIMIT 1", generation).length) {
          firstIncrementalPublicationSeconds = (clock.now - runStart) / 1000;
          artistsCompletedAtFirstPublication = numericProgress(job()?.progress_json).seedArtistsDone ?? 0;
        }
        if (firstNewArtistSeconds === null && database.inspect<{ count: number }>("SELECT live_bucket_count AS count FROM refresh_state WHERE singleton=1")[0]!.count > initialArtistCount)
          firstNewArtistSeconds = (clock.now - runStart) / 1000;
        if (firstRecommendationSeconds === null && database.inspect<{ count: number }>("SELECT candidate_count AS count FROM refresh_state")[0]!.count > 0)
          firstRecommendationSeconds = (clock.now - runStart) / 1000;
        if (firstQuotaCoverage === null && Object.values(spotify.metrics.endpoints).reduce((sum, endpoint) => sum + endpoint.quota, 0) > previousQuotaCount) {
          firstQuotaCoverage = database.inspect<{ count: number }>("SELECT count(DISTINCT bucket_artist_id) AS count FROM recordings WHERE generation=?", generation)[0]!.count;
          firstQuotaPublishedRecordings = numericProgress(job()?.progress_json).publishedRecordings ?? 0;
        }
        if (result.crashed) queue.retry(delivery, 1);
        else if (retryDelay !== undefined || !acknowledged) queue.retry(delivery, retryDelay ?? 30);
        emit({ event: result.crashed ? "crash" : "delivery", at: new Date(clock.now).toISOString(), run, phase: current.phase, revision: current.revision, ...result, backlog: queue.size });
        if (queue.metrics.deadLetters) throw new Error("A message exhausted its delivery retry budget");
      }
      const beforeStale = totalAttempts(spotify.metrics.endpoints);
      const beforeBacklog = queue.size;
      let staleAcked = false;
      const stale: Message<RefreshMessage> = { id: "completed-generation-probe", timestamp: new Date(clock.now),
        body: { generation, revision: 0 }, attempts: 2, ack: () => { staleAcked = true; }, retry: () => {} };
      await invoke(() => consumeRefreshQueue({ queue: "simulator-refresh", messages: [stale],
        metadata: { metrics: { backlogCount: queue.size, backlogBytes: queue.size * 100 } },
        ackAll: () => stale.ack(), retryAll: () => stale.retry() }, environment));
      const staleIgnored = staleAcked && !job() && queue.size === beforeBacklog && totalAttempts(spotify.metrics.endpoints) === beforeStale;
      const snapshot = await statusSnapshot(environment);
      const state = database.inspect<{ live_generation: string; candidate_count: number; live_bucket_count: number; last_outcome: string }>("SELECT live_generation,candidate_count,live_bucket_count,last_outcome FROM refresh_state WHERE singleton=1")[0]!;
      const rows = database.inspect<{ recording_key: string; spotify_id: string; recording_artist: string; slot_artist: string }>(`SELECT s.recording_key,r.spotify_id,r.bucket_artist_id AS recording_artist,s.bucket_artist_id AS slot_artist FROM recommendation_slots s JOIN recordings r
        ON r.generation=s.generation AND r.recording_key=s.recording_key WHERE s.generation=?`, state.live_generation);
      const actual = new Map(rows.map((row) => [row.recording_key, row.spotify_id]));
      const expectedArtists = new Set([...catalogue.expected.values()].map((track) => catalogue.artists[track.artistIndex]!.id));
      const artistAssignmentsValid = rows.every((row) => {
        const expected = catalogue.expected.get(row.recording_key);
        return expected && row.recording_artist === catalogue.artists[expected.artistIndex]!.id && row.slot_artist === row.recording_artist;
      });
      const missing = [...catalogue.expected.keys()].filter((key) => !actual.has(key));
      const extra = [...actual.keys()].filter((key) => !catalogue.expected.has(key));
      const wrongRepresentative = [...catalogue.expected].filter(([key, track]) => actual.has(key) && actual.get(key) !== track.body.id);
      const buckets = database.inspect<{ count: number; largest: number; smallest: number }>("SELECT count(*) AS count,max(bucket_slot) AS largest,min(bucket_slot) AS smallest FROM recommendation_buckets WHERE generation=?", state.live_generation)[0]!;
      const badTrackSlots = database.inspect<{ bucket_artist_id: string }>(`SELECT bucket_artist_id FROM recommendation_slots WHERE generation=? GROUP BY bucket_artist_id
        HAVING min(track_slot) != 1 OR max(track_slot) != count(*)`, state.live_generation);
      const badBuckets = database.inspect(`SELECT b.bucket_artist_id FROM recommendation_buckets b WHERE b.generation=? AND b.track_count !=
        (SELECT count(*) FROM recommendation_slots s WHERE s.generation=b.generation AND s.bucket_artist_id=b.bucket_artist_id)`, state.live_generation);
      const progress = snapshot.progress;
      const allProgress = numericProgress(database.inspect<{ progress: string }>("SELECT last_progress_json AS progress FROM refresh_state WHERE singleton=1")[0]?.progress);
      const endpoints = difference(spotify.metrics.endpoints, previousRequests);
      const recorded = Object.values(snapshot.requests).reduce((sum, item) => sum + item.attempts, 0);
      const requests = totalAttempts(endpoints);
      let publicValid = true;
      let previousId: string | null = null;
      for (let sample = 0; sample < Math.min(25, Math.max(1, catalogue.expected.size)); sample++) {
        const request = new Request(`http://simulator.invalid/api/recommendation${previousId ? `?exclude=${previousId}` : ""}`);
        let response: Response | undefined;
        await invoke(async () => { response = await worker.fetch(request, environment); });
        const result = await response!.json() as { recommendation: { spotify_id: string } | null; candidateCount: number };
        const id = result.recommendation?.spotify_id;
        publicValid &&= response!.ok && (actual.size === 0 ? !id : Boolean(id && [...actual.values()].includes(id)))
          && (actual.size < 2 || previousId !== id) && result.candidateCount === actual.size;
        previousId = id ?? null;
      }
      const checks: Record<string, boolean> = {
        promoted: state.last_outcome === "promoted" && state.live_generation === generation,
        expectedRecordingSet: missing.length === 0 && extra.length === 0,
        expectedRepresentatives: wrongRepresentative.length === 0,
        expectedArtistBuckets: artistAssignmentsValid && state.live_bucket_count === expectedArtists.size,
        permanentExclusionsRetained: catalogue.never.every(({ track }) => database.inspect("SELECT 1 FROM never_recordings WHERE spotify_id=? AND isrc=?", track.requestedId, track.canonical).length > 0),
        shelfCount: state.candidate_count === actual.size && actual.size === catalogue.expected.size,
        denseArtistSlots: buckets.count === state.live_bucket_count && (buckets.count === 0 || (buckets.smallest === 1 && buckets.largest === buckets.count)),
        denseTrackSlots: badTrackSlots.length === 0 && badBuckets.length === 0,
        everyArtistCompleted: progress.seedArtists === config.artists && progress.seedArtistsDone === config.artists,
        likedScanCount: progress.likedTracksScanned === config.artists,
        stagedCounter: progress.stagedRecordings === database.inspect<{ count: number }>("SELECT count(*) AS count FROM recordings WHERE generation=?", generation)[0]!.count,
        staleDeliveriesIgnored: staleIgnored,
        completedTrackChecks: progress.tracksProcessed === progress.tracksDiscovered && progress.tracksProcessed === (progress.tracksFetched ?? 0) + (progress.tracksCached ?? 0) + (progress.tracksKnown ?? 0),
        publicRecommendations: publicValid,
        requestAccounting: recorded <= requests && (crashes > crashesBefore || recorded === requests),
        retainedGenerations: generations.every((retained) => database.inspect("SELECT 1 FROM recording_generations WHERE generation=?", retained).length === 1),
        foreignKeys: database.inspect("PRAGMA foreign_key_check").length === 0,
        databaseIntegrity: database.inspect<{ quick_check: string }>("PRAGMA quick_check")[0]?.quick_check === "ok",
      };
      const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
      if (missing.length) failures.push(`Missing ${missing.length} recordings; first: ${missing.slice(0, 3).join(", ")}`);
      if (extra.length) failures.push(`Unexpected ${extra.length} recordings; first: ${extra.slice(0, 3).join(", ")}`);
      if (wrongRepresentative.length) failures.push(`${wrongRepresentative.length} representative mismatches`);
      runs.push({ run, outcome: state.last_outcome, virtualSeconds: (clock.now - runStart) / 1000, candidates: actual.size,
        expectedCandidates: catalogue.expected.size, artistsCompleted: allProgress.seedArtistsDone ?? 0, requestAttempts: requests,
        endpoints, progress, recordedRequestAttempts: recorded, firstQuotaCoverage, firstRecommendationSeconds,
        firstIncrementalPublicationSeconds, firstNewArtistSeconds, artistsCompletedAtFirstPublication, firstQuotaPublishedRecordings, checks, failures });
      if (failures.length) throw new Error(`Run ${run} failed: ${failures.join("; ")}`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    try {
      const pending = job();
      if (pending) unfinishedJob = { status: pending.status, phase: pending.phase, revision: pending.revision,
        retryAt: pending.retry_at, leaseUntil: pending.lease_until, progress: numericProgress(pending.progress_json) };
    } catch { /* A schema/setup failure can occur before a job table exists. */ }
  }
  finally {
    globalThis.fetch = original.fetch; Date.now = original.now; Math.random = original.random; console.log = original.log; console.error = original.error;
    database.close(); await rm(folder, { recursive: true, force: true });
  }
  return { schemaVersion: 1, passed: !failure, config, virtualStart: new Date(EPOCH).toISOString(), virtualEnd: new Date(clock.now).toISOString(),
    virtualDays: (clock.now - EPOCH) / 86_400_000, wallSeconds: (performance.now() - started) / 1000,
    fixture: { artists: config.artists, albums: catalogue.albums.size, trackAppearances: catalogue.appearances,
      expectedRecordings: catalogue.expected.size, neverRecordings: catalogue.never.length, playlists: catalogue.playlists.length },
    runs, api: spotify.metrics, database: database.metrics, queue: queue.metrics, injectedCrashes: crashes, cronWakes, watchdogTicks, watchdogWakes,
    remainingQueueMessages: queue.size, ...(failure ? { failure } : {}), ...(unfinishedJob ? { unfinishedJob } : {}), recentEvents, recentApiErrors: spotify.errors, recentWorkerEvents: workerEvents,
    limitations: ["Quota capacities and reset windows are synthetic assumptions, not discovered Spotify limits.",
      "SQLite executes real SQL; Cloudflare CPU, network latency, D1 scanned/indexed rows and read replication are not modeled.",
      "Request observations may be lost on hard termination, as in production; fake API totals remain authoritative.",
      "The scheduler models serialized queue consumers, retention, retries and duplicates; parallel consumer races remain integration-test concerns."] };
}
