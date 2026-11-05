import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployLocal } from "./deploy-local.mjs";

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ferto-deploy-test-"));
  await writeFile(join(root, ".gitignore"), ".local/\nbackups/\n.release/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const config = { name: "ferto", main: "src/worker.ts", assets: { directory: "dist" }, vars: { SPOTIFY_CLIENT_ID: "fixture", OWNER_SPOTIFY_ID: "owner", APP_ORIGIN: "https://ferto.example.com" },
    d1_databases: [{ binding: "DB", database_name: "ferto", database_id: "11111111-1111-4111-8111-111111111111", migrations_dir: "migrations" }],
    queues: { producers: [{ queue: "ferto-refresh" }], consumers: [{ queue: "ferto-refresh" }] } };
  const configFile = join(root, "wrangler.production.jsonc"); await writeFile(configFile, JSON.stringify(config));
  await mkdir(join(root, ".release"));
  const packaged = structuredClone(config); packaged.main = "worker/worker.js"; packaged.assets.directory = "./assets";
  await writeFile(join(root, ".release/wrangler.jsonc"), JSON.stringify(packaged));
  await writeFile(join(root, ".release/manifest.json"), JSON.stringify({ revision: "a".repeat(40), files: { "migrations/0001.sql": "fixture" } }));
  const events = []; let paused = Boolean(options.alreadyPaused); let version = "11111111-1111-4111-8111-111111111111";
  const deployedVersion = "22222222-2222-4222-8222-222222222222";
  const dependencies = {
    verify: async () => { events.push("verify"); },
    queue: async () => ({ settings: { delivery_paused: paused } }),
    json: async args => {
      if (args[0] === "deployments") return [{ created_on: "2026-01-01T00:00:00Z", versions: [{ version_id: version, percentage: 100 }] }];
      return [{ success: true, results: options.pendingMigration ? [] : [{ name: "0001.sql" }] }];
    },
    backup: async () => { events.push("backup"); if (options.backupFails) throw new Error("backup failed"); return { directory: join(root, "backups/fixture") }; },
    verifyBackup: async () => {
      events.push("verify-prepared-backup");
      return { manifest: { completedAt: new Date().toISOString(), database: { id: config.d1_databases[0].database_id, name: "ferto" }, origin: config.vars.APP_ORIGIN, workerVersion: options.staleBackup ? "older-version" : version, source: { revision: "a".repeat(40), dirty: false } } };
    },
    run: async args => {
      if (args[0] === "queues") {
        events.push(args[1]); paused = args[1] === "pause-delivery"; return "";
      }
      if (args[0] === "d1") { events.push("migrate"); if (options.migrationFails) throw new Error("migration failed"); return ""; }
      if (args[0] === "deploy") { events.push("deploy"); version = deployedVersion; return `Current Version ID: ${deployedVersion}`; }
      throw new Error("Unexpected command");
    },
    drain: async milliseconds => {
      events.push("drain"); assert.equal(milliseconds, 16 * 60000);
      if (options.changedArtifact) await writeFile(join(root, ".release/manifest.json"), JSON.stringify({ revision: "b".repeat(40), files: {} }));
      if (options.externalDeploy) version = "33333333-3333-4333-8333-333333333333";
    },
    smoke: async () => { events.push("smoke"); if (options.smokeFails) throw new Error("wrong assets"); return { revision: "a".repeat(40) }; },
  };
  return { root, configFile, dependencies, events, paused: () => paused };
}

test("successful local release backs up, pauses/drains, checks the exact deployment and resumes in order", async () => {
  const f = await fixture();
  try {
    const result = await deployLocal(f);
    assert.equal(result.status, "complete"); assert.equal(f.paused(), false);
    assert.deepEqual(f.events, ["verify", "backup", "pause-delivery", "drain", "verify", "deploy", "smoke", "resume-delivery"]);
    await assert.rejects(readFile(join(f.root, ".local/releases/.lock/owner.json")), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("an offline plan validates the artifact and performs no provider calls", async () => {
  const f = await fixture();
  try { const result = await deployLocal({ ...f, plan: true }); assert.equal(result.plan, true); assert.deepEqual(f.events, ["verify"]); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test("CI can reuse its saved verified backup without a second export, but stale backups stop before pausing", async () => {
  for (const staleBackup of [false, true]) {
    const f = await fixture({ staleBackup });
    try {
      const release = deployLocal({ ...f, backupDirectory: join(f.root, "backups/saved") });
      if (staleBackup) { await assert.rejects(release, /Prepared backup/); assert.ok(!f.events.includes("pause-delivery")); }
      else { assert.equal((await release).status, "complete"); assert.equal(f.paused(), false); assert.ok(f.events.includes("verify-prepared-backup")); }
      assert.ok(!f.events.includes("backup"));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

for (const [name, options] of [["failed backup", { backupFails: true }], ["unreviewed migration", { pendingMigration: true }], ["already paused queue", { alreadyPaused: true }]]) {
  test(`${name} stops before a new pause or deployment`, async () => {
    const f = await fixture(options);
    try { await assert.rejects(deployLocal(f)); assert.ok(!f.events.includes("pause-delivery")); assert.ok(!f.events.includes("deploy")); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const [name, options] of [["failed migration", { pendingMigration: true, migrationFails: true }], ["failed smoke", { smokeFails: true }], ["changed artifact", { changedArtifact: true }], ["external deployment", { externalDeploy: true }]]) {
  test(`${name} keeps delivery paused and never resumes automatically`, async () => {
    const f = await fixture(options);
    try {
      await assert.rejects(deployLocal({ ...f, migrate: true }), /Queue pause was requested/);
      assert.equal(f.paused(), true); assert.ok(!f.events.includes("resume-delivery"));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}
