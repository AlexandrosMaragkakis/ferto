import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import historyMigration from "../migrations/0020_operational_history.sql?raw";
import { observeDatabase, operationalHistory, recordEndpointActivity, observedInvocation } from "../src/operations";
import { statements } from "./statements";

beforeAll(async () => {
  await env.DB.prepare("CREATE TABLE rebuild_jobs(generation TEXT, started_at INTEGER, progress_json TEXT, request_counts_json TEXT)").run();
  await env.DB.prepare("CREATE TABLE refresh_state(singleton INTEGER PRIMARY KEY,live_generation TEXT)").run();
  await env.DB.prepare("INSERT INTO refresh_state VALUES (1,NULL)").run();
  for (const sql of statements(historyMigration)) await env.DB.prepare(sql).run();
  await env.DB.prepare("CREATE TABLE metric_fixture(id INTEGER PRIMARY KEY, value TEXT)").run();
});

describe("operational observations", () => {
  it("captures row metadata for first, all, run and transactional batches", async () => {
    const observed = observeDatabase(env.DB);
    await observed.database.prepare("INSERT INTO metric_fixture VALUES (1,'one')").run();
    expect(await observed.database.prepare("SELECT value FROM metric_fixture WHERE id=?").bind(1).first("value")).toBe("one");
    await observed.database.batch([observed.database.prepare("UPDATE metric_fixture SET value='two' WHERE id=1"), observed.database.prepare("SELECT * FROM metric_fixture")]);
    expect(observed.usage.queries).toBe(4);
    expect(observed.usage.rowsRead).toBeGreaterThanOrEqual(2);
    expect(observed.usage.rowsWritten).toBeGreaterThanOrEqual(2);
    // Compare the binding's own scanned-row count, rather than deriving it
    // from the one COUNT row returned to application code.
    const direct = await env.DB.prepare("SELECT count(*) AS count FROM metric_fixture").all();
    const before = observed.usage.rowsRead;
    await observed.database.prepare("SELECT count(*) AS count FROM metric_fixture").first();
    expect(observed.usage.rowsRead - before).toBe(direct.meta.rows_read);
  });

  it("combines endpoint attempts into an hour, computes yield, and keeps real row totals", async () => {
    const usage = { tracks: { attempts: 3, succeeded: 2, failed: 1, rateLimited: 1, lastAttemptAt: 5, lastSuccessAt: 4 } };
    await env.DB.prepare("INSERT INTO refresh_history(generation,started_at,progress_json,request_counts_json) VALUES ('history-test',1,?,?)")
      .bind(JSON.stringify({ stagedRecordings: 6, newRecordings: 6 }), JSON.stringify(usage)).run();
    await env.DB.prepare("UPDATE refresh_history SET outcome='promoted' WHERE generation='history-test'").run();
    await recordEndpointActivity(env, "history-test", usage);
    await recordEndpointActivity(env, "history-test", usage);
    await observedInvocation(env, "refresh", "history-test", async (observed) => observed.DB.prepare("SELECT * FROM metric_fixture").all());
    const result = await operationalHistory(env);
    const run = result.history.find((row) => row.generation === "history-test")!;
    expect(run.discoveriesPerRequest).toBe(2);
    expect(run.db_queries).toBe(1);
    expect(result.activity[0].requests.tracks?.attempts).toBe(6);
    expect(result.rowMetricWritesExcluded).toBe(true);
    expect(result.observationBasis).toBe("observed");
  });
});
