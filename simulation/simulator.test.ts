import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simulationConfig, seededRandom } from "./config";
import { SimulationDatabase } from "./database";
import { SyntheticCatalogue } from "./catalogue";
import { SimulationQueue, type Delivery } from "./queue";
import { SyntheticSpotify } from "./spotify";
import { runSimulation } from "./engine";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";

export async function main(_args: string[], root: string): Promise<void> {
  await test("SQLite adapter", async (t) => {
    const folder = await mkdtemp(join(tmpdir(), "ferto-d1-test-"));
    const database = new SimulationDatabase(join(folder, "test.sqlite"), 50);
    try {
      database.migrate("CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)");
      await t.test("executes bound SQL and JSON, first() and metadata", async () => {
        database.beginInvocation();
        const result = await database.binding.prepare("INSERT INTO example VALUES (?,?)").bind(1, "hello").run();
        assert.equal(result.meta.changes, 1);
        assert.equal(await database.binding.prepare("SELECT value FROM example WHERE id=?").bind(1).first("value"), "hello");
        assert.equal(await database.binding.prepare("SELECT * FROM example WHERE id=?").bind(2).first(), null);
        assert.equal(await database.binding.prepare("SELECT json_extract(?, '$.saved') AS saved").bind('{"saved":7}').first("saved"), 7);
        assert.equal(database.endInvocation(), 4);
      });
      await t.test("rolls back an entire batch on a later statement failure", async () => {
        const writes = database.metrics.rowsChanged;
        database.beginInvocation();
        await assert.rejects(database.binding.batch([
          database.binding.prepare("INSERT INTO example VALUES (2,'second')"),
          database.binding.prepare("INSERT INTO example VALUES (3,'hello')"),
        ]));
        database.endInvocation();
        assert.equal(database.inspect("SELECT * FROM example WHERE id=2").length, 0);
        assert.equal(database.metrics.rowsChanged, writes);
      });
      await t.test("a hard termination blocks later SQL and survives reopen without a partial transaction", async () => {
        database.beginInvocation(2);
        await assert.rejects(database.binding.batch([
          database.binding.prepare("INSERT INTO example VALUES (4,'four')"),
          database.binding.prepare("INSERT INTO example VALUES (5,'five')"),
        ]));
        assert.equal(database.crashed, true);
        await assert.rejects(database.binding.prepare("SELECT 1").all());
        database.endInvocation(); database.reopen();
        assert.equal(database.inspect("SELECT * FROM example WHERE id IN (4,5)").length, 0);
        assert.equal(database.inspect("SELECT * FROM example WHERE id=1").length, 1);
      });
      await t.test("rejects unsupported bindings and too many parameters", () => {
        assert.throws(() => database.binding.prepare("SELECT ?").bind(undefined), /Unsupported/);
        assert.throws(() => database.binding.prepare("SELECT ?").bind(...Array(101).fill(1)), /binding limit/);
      });
    } finally { database.close(); await rm(folder, { recursive: true, force: true }); }
  });

  await test("queue model", async (t) => {
    await t.test("orders deliveries and clones message bodies", async () => {
      let now = 1000;
      const queue = new SimulationQueue(() => now, seededRandom(42), simulationConfig({ duplicateEvery: 1 }));
      const body = { generation: "original", revision: 1 };
      await queue.binding.send(body, { delaySeconds: 120 }); body.generation = "mutated";
      await queue.binding.send({ generation: "first", revision: 1 });
      let lastDue = -1; const deliveries: Delivery[] = [];
      while (queue.size) { const item = queue.pop()!; assert.ok(item.dueAt >= lastDue); lastDue = item.dueAt; deliveries.push(item); }
      assert.equal(deliveries[0]!.body.generation, "first");
      assert.ok(deliveries.some((item) => item.body.generation === "original"));
      assert.ok(!deliveries.some((item) => item.body.generation === "mutated"));
      assert.equal(queue.metrics.duplicates, 2);
      const original = deliveries.find((item) => item.body.generation === "original" && item.attempts === 1)!;
      const duplicate = deliveries.find((item) => item.body.generation === "original" && item.attempts === 2)!;
      assert.equal(duplicate.id, original.id); assert.equal(duplicate.createdAt, original.createdAt);
      now += 86_400_000; assert.equal(queue.expired(deliveries[0]!), true);
    });
    await t.test("redeliveries keep retention age and exhaust eight retries", async () => {
      const queue = new SimulationQueue(() => 1000, seededRandom(1), simulationConfig());
      await queue.binding.send({ generation: "test", revision: 1 });
      for (let attempt = 1; attempt <= 9; attempt++) {
        const item = queue.pop()!; assert.equal(item.attempts, attempt); assert.equal(item.createdAt, 1000); queue.retry(item, 30);
      }
      assert.equal(queue.size, 0); assert.equal(queue.metrics.deadLetters, 1);
      await assert.rejects(queue.binding.send({ generation: "test", revision: 1 }, { delaySeconds: 43_201 }), /out of range/);
    });
  });

  await test("synthetic Spotify", async (t) => {
    for (const mode of ["seconds", "date", "missing"] as const) await t.test(`quota windows and ${mode} Retry-After`, async () => {
      const config = simulationConfig({ artists: 1, trackQuota: 1, quotaWindowSeconds: 1800, retryAfter: mode });
      let now = Date.UTC(2026, 9, 18, 3);
      const catalogue = new SyntheticCatalogue(config); const api = new SyntheticSpotify(catalogue, config, () => now, now);
      api.beginInvocation();
      const tokenResponse = await api.fetch("https://accounts.spotify.com/api/token", { method: "POST", body: new URLSearchParams({ client_id: "simulator-client", refresh_token: "simulator-refresh-token" }) });
      const token = await tokenResponse.json() as { access_token: string };
      const init = { headers: { Authorization: `Bearer ${token.access_token}` } };
      const url = `https://api.spotify.com/v1/tracks/${catalogue.likes[0]!.requestedId}`;
      assert.equal((await api.fetch(url, init)).status, 200);
      const limited = await api.fetch(url, init); assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("Retry-After"), mode === "seconds" ? "1800" : mode === "missing" ? null : new Date(now + 1800_000).toUTCString());
      now += 1800_000; api.beginInvocation(); assert.equal((await api.fetch(url, init)).status, 200);
      assert.equal(api.metrics.quotaWindowResets, 1); assert.equal(api.metrics.earlyRequests, 0);
      await assert.rejects(api.fetch("https://example.com"), /blocked/); assert.equal(api.metrics.unexpectedRequests, 1);
    });
  });

  await test("real refresh state machine", async (t) => {
    await t.test("finishes a complete catalogue and validates public draws and exclusions", async () => {
      const report = await runSimulation({ artists: 6 }, { root });
      assert.equal(report.passed, true, report.failure);
      assert.equal(report.runs[0]!.artistsCompleted, 6);
      assert.equal(report.runs[0]!.candidates, report.fixture.expectedRecordings);
      assert.ok(Object.values(report.runs[0]!.checks).every(Boolean));
      assert.ok(report.database.maxStatementsPerInvocation <= 50);
    });
    for (const [label, overrides] of [
      ["liked pages", { artists: 51, albumsPerArtist: 1 }],
      ["release pages", { artists: 1, albumsPerArtist: 11 }],
      ["album track pages", { artists: 1, albumsPerArtist: 1, tracksPerAlbum: 51 }],
      ["playlist listing pages", { artists: 1, playlists: 52 }],
    ] as const) await t.test(`follows all ${label}`, async () => {
      const report = await runSimulation(overrides, { root }); assert.equal(report.passed, true, report.failure);
    });
    await t.test("survives quota waits longer than message retention", async () => {
      const report = await runSimulation({ scenario: "quota", artists: 6, trackQuota: 8, catalogueQuota: 20 }, { root });
      assert.equal(report.passed, true, report.failure); assert.ok(report.virtualDays > 2);
      assert.ok((report.api.endpoints.tracks?.quota ?? 0) > 0); assert.equal(report.queue.expired, 0);
      assert.equal(report.queue.deadLetters, 0); assert.equal(report.api.earlyRequests, 0);
    });
    await t.test("recovers process crashes, outages, 401s, lost dispatches and source changes", async () => {
      const report = await runSimulation({ scenario: "chaos", artists: 12 }, { root });
      assert.equal(report.passed, true, report.failure);
      assert.equal(report.injectedCrashes, 2); assert.equal(report.queue.dispatchFailures, 1); assert.equal(report.queue.lostMessages, 1);
      assert.ok(report.queue.duplicates > 0); assert.ok(report.watchdogWakes > 0);
      assert.equal(report.api.injected503, 6); assert.equal(report.api.injectedNetwork, 1); assert.equal(report.api.injectedExpiry, 1);
      assert.ok(report.api.disappearedPlaylists > 0); assert.equal(report.api.snapshotChanges, 1);
      assert.ok(Object.values(report.api.endpoints).some((endpoint) => endpoint.rateLimited > 0));
      assert.equal(report.api.earlyRequests, 0); assert.equal(report.queue.deadLetters, 0);
    });
    await t.test("reuses caches in a second refresh without losing retained generations", async () => {
      const report = await runSimulation({ scenario: "warm", artists: 12 }, { root });
      assert.equal(report.passed, true, report.failure); assert.equal(report.runs.length, 2);
      assert.ok(report.runs[1]!.requestAttempts < report.runs[0]!.requestAttempts);
      assert.ok((report.runs[1]!.progress.tracksCached ?? 0) > 0);
      assert.equal(report.runs[0]!.progress.newRecordings, report.runs[0]!.expectedCandidates);
      assert.equal(report.runs[1]!.progress.newRecordings, 0);
    });
    await t.test("recovers a lost wake within a quarter-hour tick instead of waiting a week", async () => {
      const report = await runSimulation({ artists: 6, lostMessages: 1 }, { root });
      assert.equal(report.passed, true, report.failure);
      assert.equal(report.queue.lostMessages, 1); assert.equal(report.watchdogWakes, 1);
      assert.equal(report.cronWakes, 0); assert.ok(report.runs[0]!.virtualSeconds < 1800);
    });
    await t.test("reuses identity with fresh weekly availability, then refetches identity after thirty days", async () => {
      const report = await runSimulation({ scenario: "warm", artists: 12, runs: 6, betweenRunsSeconds: 604800 }, { root });
      assert.equal(report.passed, true, report.failure);
      const [cold, warm] = report.runs; const expired = report.runs[5];
      assert.ok(warm!.requestAttempts < cold!.requestAttempts / 4);
      assert.ok((warm!.endpoints.albumTracks?.attempts ?? 0) > 0);
      assert.equal(warm!.endpoints.tracks?.attempts ?? 0, 0);
      assert.ok((expired!.endpoints.albumTracks?.attempts ?? 0) > 0);
      assert.ok(expired!.requestAttempts > warm!.requestAttempts * 2);
    });
    await t.test("spreads a tight metadata quota across artists even when the first artist is prolific", async () => {
      const config = { artists: 6, prolificArtistAlbums: 20, trackQuota: 20 };
      const serial = await runSimulation({ ...config, scheduler: "serial" }, { root });
      const fair = await runSimulation({ ...config, scheduler: "fair" }, { root });
      assert.equal(serial.passed, true, serial.failure); assert.equal(fair.passed, true, fair.failure);
      assert.ok(fair.runs[0]!.firstQuotaCoverage! >= 3);
      assert.ok(fair.runs[0]!.firstQuotaCoverage! > serial.runs[0]!.firstQuotaCoverage!);
      // First-install discoveries are already public while the remaining
      // artists continue. Existing shelves also receive completed-artist additions.
      assert.ok(fair.runs[0]!.firstRecommendationSeconds! < fair.runs[0]!.virtualSeconds);
      assert.equal(fair.runs[0]!.candidates, serial.runs[0]!.candidates);
    });
    await t.test("fresh album availability changes eligibility and changed relinks force a full lookup", async () => {
      const report = await runSimulation({ scenario: "warm", artists: 6, availabilityChanges: true, betweenRunsSeconds: 604800 }, { root });
      assert.equal(report.passed, true, report.failure);
      assert.equal(report.runs[1]!.endpoints.tracks?.attempts, 1);
      assert.equal(report.runs[1]!.progress.newRecordings, 1);
      assert.ok(Object.values(report.runs[1]!.checks).every(Boolean));
    });
    await t.test("expands an existing partial shelf before the full rebuild finishes under quotas", async () => {
      const report=await runSimulation({artists:40,initialLiveArtists:3,trackQuota:40,catalogueQuota:80}, {root});
      assert.equal(report.passed,true,report.failure);
      const run=report.runs[0]!;
      assert.ok(run.firstIncrementalPublicationSeconds!==null);
      assert.ok(run.firstNewArtistSeconds!==null && run.firstNewArtistSeconds<run.virtualSeconds/2);
      assert.ok(run.progress.publishedArtists!>0);
      assert.ok(run.progress.publishedRecordings!>0);
      assert.ok(Object.values(run.checks).every(Boolean));
    });
    await t.test("publishes song batches before any artist finishes when all data endpoints share a tight quota", async () => {
      const report = await runSimulation({ artists: 9, initialLiveArtists: 1, albumsPerArtist: 12, sharedQuota: 100, quotaWindowSeconds: 3600 }, { root });
      assert.equal(report.passed, true, report.failure);
      const run = report.runs[0]!;
      assert.equal(run.artistsCompletedAtFirstPublication, 0);
      assert.ok(run.firstQuotaPublishedRecordings! > 0);
      assert.ok(run.firstNewArtistSeconds! < 3600);
      assert.equal(report.api.earlyRequests, 0);
      assert.ok(Object.values(run.checks).every(Boolean));
    });
    await t.test("the same seed reproduces results and delivery/fault metrics", async () => {
      const config = { scenario: "chaos" as const, artists: 6, seed: 17 };
      const first = await runSimulation(config, { root }); const second = await runSimulation(config, { root });
      assert.equal(first.passed, true, first.failure); assert.equal(second.passed, true, second.failure);
      assert.deepEqual(first.api, second.api); assert.deepEqual(first.queue, second.queue);
      assert.equal(first.virtualEnd, second.virtualEnd); assert.deepEqual(first.runs, second.runs);
    });
    await t.test("reports an unfinished run and restores globals after bounded failure", async () => {
      const original = { fetch: globalThis.fetch, now: Date.now, random: Math.random, log: console.log };
      const report = await runSimulation({ maxDeliveries: 1 }, { root });
      assert.equal(report.passed, false); assert.match(report.failure!, /Delivery limit/); assert.ok(report.recentEvents.length > 0);
      assert.equal(globalThis.fetch, original.fetch); assert.equal(Date.now, original.now); assert.equal(Math.random, original.random); assert.equal(console.log, original.log);
    });
    await t.test("fails when configured invocation budgets are exceeded", async () => {
      const sql = await runSimulation({ maxStatements: 1 }, { root }); assert.equal(sql.passed, false); assert.ok(sql.database.limitViolations > 0);
      const http = await runSimulation({ maxExternalRequests: 1 }, { root }); assert.equal(http.passed, false); assert.ok(http.api.limitViolations > 0);
    });
  });
  await test("CLI contract", async (t) => {
    const folder = await mkdtemp(join(tmpdir(), "ferto-cli-test-"));
    const execute = promisify(execFile);
    try {
      await t.test("writes JSON and JSONL reports for a successful run", async () => {
        const reportPath = join(folder, 'success.json'); const tracePath = join(folder, 'trace.jsonl');
        const result = await execute(process.execPath, [join(root, 'scripts/simulate.mjs'), '--artists', '1', '--report', reportPath, '--trace', tracePath]);
        assert.match(result.stdout, /PASS:/);
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as { passed: boolean; runs: unknown[] };
        assert.equal(report.passed, true); assert.equal(report.runs.length, 1);
        const trace = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { event: string });
        assert.ok(trace.length > 0); assert.ok(trace.every((event) => ['delivery', 'cron', 'watchdog', 'crash'].includes(event.event)));
      });
      await t.test("exits nonzero and preserves a diagnostic report when bounded work is unfinished", async () => {
        const reportPath = join(folder, 'failure.json');
        await assert.rejects(execute(process.execPath, [join(root, 'scripts/simulate.mjs'), '--max-deliveries', '1', '--report', reportPath]), (error: Error & { code?: number }) => error.code === 1);
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as { passed: boolean; failure: string; unfinishedJob: { phase: string } };
        assert.equal(report.passed, false); assert.match(report.failure, /Delivery limit/); assert.ok(report.unfinishedJob.phase);
      });
      await t.test("loads a JSON preset and gives CLI overrides precedence", async () => {
        const configPath = join(folder, 'config.json'); const reportPath = join(folder, 'configured.json');
        await writeFile(configPath, JSON.stringify({ scenario: 'warm', artists: 6, seed: 17 }));
        await execute(process.execPath, [join(root, 'scripts/simulate.mjs'), '--config', configPath, '--artists', '2', '--report', reportPath]);
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as { passed: boolean; config: { artists: number; scenario: string; seed: number }; runs: unknown[] };
        assert.equal(report.passed, true); assert.deepEqual([report.config.artists, report.config.scenario, report.config.seed], [2, 'warm', 17]); assert.equal(report.runs.length, 2);
        await writeFile(configPath, JSON.stringify({ arttists: 10 }));
        await assert.rejects(execute(process.execPath, [join(root, 'scripts/simulate.mjs'), '--config', configPath]), (error: Error & { stderr?: string }) => Boolean(error.stderr?.includes('Unknown config property')));
      });
      await t.test("rejects an unknown option before running", async () => {
        await assert.rejects(execute(process.execPath, [join(root, 'scripts/simulate.mjs'), '--qupta', '500']), (error: Error & { code?: number; stderr?: string }) => error.code === 1 && Boolean(error.stderr?.includes('Unknown option')));
      });
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  await test("configuration validation", () => {
    for (const bad of [{ artists: 0 }, { seed: -1 }, { tracksPerAlbum: 5 }, { rollingLimit: NaN }, { artists: 100_000 }]) assert.throws(() => simulationConfig(bad));
    assert.deepEqual(Array.from({ length: 10 }, seededRandom(42)), Array.from({ length: 10 }, seededRandom(42)));
  });
}
