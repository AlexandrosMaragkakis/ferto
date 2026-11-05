import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBackup, listBackups, rehearseSql, verifyBackup } from "./backup.mjs";
import { ignoredOutput } from "./operations-lib.mjs";

const sql = `CREATE TABLE d1_migrations(id INTEGER, name TEXT); INSERT INTO d1_migrations VALUES(22,'0022_oauth_browser_binding_and_budgets.sql');
CREATE TABLE recordings(title TEXT); INSERT INTO recordings VALUES('Private demo song; with a quote '' and newline\nhere');
CREATE TABLE refresh_state(singleton INTEGER,live_generation TEXT,candidate_count INTEGER,live_bucket_count INTEGER); INSERT INTO refresh_state VALUES(1,'live',1,1);
CREATE TABLE owner_sessions(session_hash TEXT); INSERT INTO owner_sessions VALUES('fixture-hash');
CREATE TABLE never_recordings(recording_key TEXT); CREATE TABLE oauth_states(state_hash TEXT); CREATE TABLE request_budgets(budget_key TEXT); CREATE TABLE rebuild_jobs(generation TEXT);
CREATE TABLE recommendation_slots(generation TEXT); INSERT INTO recommendation_slots VALUES('live');
CREATE TABLE recommendation_buckets(generation TEXT); INSERT INTO recommendation_buckets VALUES('live');`;

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "ferto-backup-test-"));
  const root = join(folder, "project"); await mkdir(root);
  const configFile = join(root, "wrangler.production.jsonc");
  await writeFile(configFile, JSON.stringify({ name: "ferto", vars: { SPOTIFY_CLIENT_ID: "fixture-client", OWNER_SPOTIFY_ID: "fixture-owner", APP_ORIGIN: "https://ferto.example.com" },
    d1_databases: [{ binding: "DB", database_name: "ferto", database_id: "11111111-1111-4111-8111-111111111111" }],
    queues: { producers: [{ queue: "ferto-refresh" }], consumers: [{ queue: "ferto-refresh" }] } }));
  const calls = [];
  const runner = async args => {
    calls.push(args);
    await writeFile(args[args.indexOf("--output") + 1], sql);
    return "private signed export URL is intentionally never forwarded";
  };
  const jsonRunner = async args => {
    calls.push(args);
    if (args[0] === "deployments") return [{ created_on: "2026-01-01T00:00:00Z", versions: [{ version_id: "fixture-version", percentage: 100 }] }];
    if (args[1] === "info") return { database_size: 1024 };
    return { bookmark: "fixture-bookmark" };
  };
  return { folder, root, configFile, output: join(folder, "backups"), runner, jsonRunner, calls };
}

test("backup verifies a compressed full export, preserves private data without printing it, and excludes credentials", async () => {
  const f = await fixture();
  try {
    const result = await createBackup(f);
    assert.equal(result.manifest.verification.tableCounts.owner_sessions, 1);
    assert.equal(result.manifest.verification.candidateCount, 1);
    assert.equal(result.manifest.verification.integrity, "ok");
    assert.ok(f.calls.some(args => args.includes("--remote") && args.includes("--skip-confirmation")));
    assert.ok(!f.calls.some(args => args.includes("restore") || args.includes("execute")));
    assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
    for (const name of ["manifest.json", "database.sql.gz", "instance.json"]) assert.equal((await stat(join(result.directory, name))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(result.directory)).sort(), ["database.sql.gz", "instance.json", "manifest.json"]);
    assert.ok(!(await readFile(join(result.directory, "manifest.json"), "utf8")).includes("Private demo song"));
    assert.equal((await verifyBackup(result.directory)).verification.candidateCount, 1);
    assert.equal((await listBackups(f.output)).length, 1);
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

test("corrupted archives are rejected and an unsuccessful new export never removes a good backup", async () => {
  const f = await fixture();
  try {
    const good = await createBackup(f);
    await assert.rejects(createBackup({ ...f, runner: async () => { throw new Error("provider response containing private material"); } }), /incomplete data and protected logs/);
    const incomplete = (await readdir(f.output)).find(name => name.startsWith(".partial-"));
    await assert.rejects(verifyBackup(join(f.output, incomplete)), /Incomplete backup/);
    assert.equal((await listBackups(f.output)).length, 1);
    await verifyBackup(good.directory);
    await writeFile(join(good.directory, "database.sql.gz"), "damaged");
    await assert.rejects(verifyBackup(good.directory), /checksum mismatch/);
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

test("incomplete or symlinked archives are never accepted as a verified backup", async () => {
  const f = await fixture();
  try {
    const good = await createBackup(f);
    const archive = join(good.directory, "database.sql.gz");
    const outside = join(f.folder, "outside.gz"); await writeFile(outside, await readFile(archive));
    await rm(archive); await symlink(outside, archive);
    await assert.rejects(verifyBackup(good.directory), /regular owner-only/);
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

test("restore rehearsal rejects attached databases and leaves external files alone", async () => {
  const f = await fixture();
  try {
    const outside = join(f.folder, "must-not-exist.sqlite");
    await assert.rejects(rehearseSql(`ATTACH DATABASE '${outside.replaceAll("'", "''")}' AS escaped;`, join(f.folder, "test.sqlite")));
    await assert.rejects(stat(outside), { code: "ENOENT" });
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

test("missing catalogue tables and inconsistent slot counts fail verification", async () => {
  const f = await fixture();
  try {
    await assert.rejects(rehearseSql("CREATE TABLE unrelated(id INTEGER);", join(f.folder, "empty.sqlite")), /required FERTO/);
    await assert.rejects(rehearseSql(sql.replace("VALUES(1,'live',1,1)", "VALUES(1,'live',2,1)"), join(f.folder, "bad.sqlite")), /catalogue counts/);
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

test("a dotted child directory cannot bypass the public-output guard", async () => {
  const f = await fixture();
  try { await assert.rejects(ignoredOutput(join(f.root, "..public"), f.root), /must be ignored/); }
  finally { await rm(f.folder, { recursive: true, force: true }); }
});
