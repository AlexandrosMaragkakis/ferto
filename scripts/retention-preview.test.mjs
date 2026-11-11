import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackup } from "./backup.mjs";
import { analyzeRetention, previewRetention } from "./retention-preview.mjs";

const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort();
const schema = `CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO d1_migrations VALUES(23,'0023_never_isrc_lookup.sql');\n` +
  (await Promise.all(migrations.map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")))).join("\n");
const record = (generation, key, id) => `INSERT INTO recordings(generation,recording_key,spotify_id,title,album_name,spotify_url,artists_json,bucket_artist_id) VALUES('${generation}','${key}','${id.repeat(22)}','private-library-title','Fixture','https://open.spotify.com/track/${id.repeat(22)}','[]','artist');`;
const seed = [
  record("live", "isrc:USABC0000001", "A"), record("old", "isrc:USABC0000002", "B"), record("active", "isrc:USABC0000003", "C"),
  record("orphan-duplicate", "isrc:USABC0000001", "A"), record("orphan-unique", "isrc:USABC0000004", "D"), record("orphan-conflict", "isrc:USABC0000005", "A"),
  "INSERT INTO recording_generations VALUES('live',1),('old',0);",
  "UPDATE refresh_state SET live_generation='live',candidate_count=1,live_bucket_count=1;",
  "INSERT INTO recommendation_buckets VALUES('live',1,'artist',1);",
  "INSERT INTO recommendation_slots VALUES('live','artist',1,'isrc:USABC0000001');",
  "INSERT INTO rebuild_jobs(singleton,generation,status,phase,started_at,updated_at) VALUES(1,'active','active','seeds',1,1);",
  "INSERT INTO refresh_history(generation,base_generation,started_at) VALUES('historical-work','old',1);",
  "INSERT INTO refresh_publications VALUES('ledger-work','live','isrc:USABC0000001','artist',1);",
  "INSERT INTO never_recordings VALUES('isrc:USABC0000009','USABC0000009','ZZZZZZZZZZZZZZZZZZZZZZ',1);",
  "INSERT INTO spotify_track_cache VALUES('owner','US','expired','{}',0),('owner','US','boundary','{}',100000),('owner','US','fresh','{}',200000);",
  "INSERT INTO album_track_pages VALUES('ctx','fresh-parent','','[]',NULL,200000),('ctx','old-parent','','[]',NULL,0);",
  "INSERT INTO album_availability_pages VALUES('ctx','fresh-parent','',0),('ctx','old-parent','',0);",
].join("\n");
const sql = schema + "\n" + seed;

test("preserves all live/promoted/job/history/ledger generations and unique aliases", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    const report = analyzeRetention(db, { asOf: 100000 });
    const generations = new Map(report.generations.map(row => [row.generation, row]));
    assert.deepEqual(report.generations.filter(row => row.cleanupCandidate).map(row => row.generation), ["orphan-duplicate"]);
    for (const name of ["live", "old", "active", "historical-work", "ledger-work", "orphan-unique", "orphan-conflict"]) assert.equal(generations.get(name).cleanupCandidate, false, name);
    assert.ok(report.alwaysRetained.includes("never_recordings"));
    assert.ok(report.alwaysRetained.includes("never_identity_checks"));
    assert.ok(!JSON.stringify(report).includes("private-library-title"));
    db.exec("UPDATE rebuild_jobs SET status='failed'");
    assert.ok(analyzeRetention(db, { asOf: 100000 }).generations.find(row => row.generation === "active").retainedReasons.includes("current-job:failed"));
  } finally { db.close(); }
});

test("expired availability markers stay while their album discovery pages are fresh", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    const report = analyzeRetention(db, { asOf: 100000 });
    assert.equal(report.expiredCaches.find(row => row.table === "spotify_track_cache").candidateRows, 2);
    assert.equal(report.expiredCaches.find(row => row.table === "album_track_pages").candidateRows, 1);
    const markers = report.expiredCaches.find(row => row.table === "album_availability_pages");
    assert.equal(markers.expiredRows, 2); assert.equal(markers.candidateRows, 1); assert.equal(markers.retainedExpiredRows, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spotify_track_cache").get().n, 3);
    assert.match(report.storage.basis, /not Cloudflare physical storage/);
  } finally { db.close(); }
});

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "ferto-retention-"));
  try {
    const configFile = join(root, "wrangler.production.jsonc");
    const config = { name: "ferto", vars: { SPOTIFY_CLIENT_ID: "fixture", OWNER_SPOTIFY_ID: "owner", APP_ORIGIN: "https://ferto.example.com" },
      d1_databases: [{ binding: "DB", database_name: "ferto", database_id: "11111111-1111-4111-8111-111111111111" }],
      queues: { producers: [{ queue: "ferto-refresh" }], consumers: [{ queue: "ferto-refresh" }] } };
    await writeFile(configFile, JSON.stringify(config));
    const backups = join(root, "backups"); await mkdir(backups, { mode: 0o700 });
    const makeBackup = (body = sql) => createBackup({ configFile, output: backups, root: join(root, "unused-project"),
      runner: async args => { await writeFile(args[args.indexOf("--output") + 1], body); return ""; },
      jsonRunner: async args => args[0] === "deployments" ? [{ created_on: "2026-01-01", versions: [{ version_id: "fixture", percentage: 100 }] }] : args[1] === "info" ? { database_size: 123456 } : { bookmark: "fixture" },
    });
    await run({ root, config, configFile, makeBackup });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("verified-backup preview is private, offline, immutable and reports growth", async t => {
  await fixture(async ({ root, makeBackup }) => {
    const old = await makeBackup();
    const current = await makeBackup(sql + "\n" + record("active", "isrc:USABC0000006", "F"));
    const filesBefore = (await readdir(current.directory)).sort();
    const fingerprint = async () => createHash("sha256").update(await readFile(join(current.directory, "database.sql.gz"))).digest("hex");
    const before = await fingerprint();
    t.mock.method(globalThis, "fetch", () => { throw new Error("No network calls permitted"); });
    const output = join(root, "reports");
    const result = await previewRetention({ backup: current.directory, compare: old.directory, asOf: 100000, output, root: join(root, "unused-project") });
    assert.equal(result.report.growth.tables.find(row => row.name === "recordings").rowDelta, 1);
    assert.equal(result.report.growth.generations.find(row => row.generation === "active").rowsByTable.recordings.delta, 1);
    assert.equal(result.report.current.snapshot.cloudflareDatabaseBytes, 123456);
    assert.equal(result.report.mode, "preview");
    assert.equal((await stat(join(result.directory, "report.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(result.directory), ["report.json"]);
    assert.equal(await fingerprint(), before);
    assert.deepEqual((await readdir(current.directory)).sort(), filesBefore);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });
});

test("mismatched databases and corrupt backups are rejected", async () => {
  await fixture(async ({ root, config, configFile, makeBackup }) => {
    const old = await makeBackup();
    const sameDatabase = await makeBackup();
    await assert.rejects(previewRetention({ backup: old.directory, compare: sameDatabase.directory, output: join(root, "reports") }), /chronological order/);
    config.d1_databases[0].database_id = "22222222-2222-4222-8222-222222222222";
    await writeFile(configFile, JSON.stringify(config));
    const current = await makeBackup();
    await assert.rejects(previewRetention({ backup: current.directory, compare: old.directory, output: join(root, "reports") }), /same database/);
    await writeFile(join(current.directory, "database.sql.gz"), "corrupt");
    await assert.rejects(previewRetention({ backup: current.directory, output: join(root, "reports") }), /checksum mismatch/);
  });
});

test("unsupported schema and invalid times fail closed; CLI has no apply mode", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    db.exec("UPDATE d1_migrations SET name='0022_oauth_browser_binding_and_budgets.sql'; DROP INDEX never_recordings_isrc;");
    assert.equal(analyzeRetention(db, { asOf: 100000 }).expiredCaches.find(row => row.table === "spotify_track_cache").candidateRows, 2);
    db.exec("UPDATE d1_migrations SET name='future-schema.sql'");
    assert.throws(() => analyzeRetention(db), /Unsupported retention schema/);
    assert.throws(() => analyzeRetention(db, { asOf: NaN }), /Invalid preview time/);
  } finally { db.close(); }
  const result = spawnSync(process.execPath, [resolve("scripts/retention-preview.mjs"), "--apply"], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /no apply mode/);
});
