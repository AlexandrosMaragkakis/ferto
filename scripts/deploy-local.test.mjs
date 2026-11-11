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
  const previousVersion = version;
  let deployed = false; let staleReads = options.staleDeploymentReads ?? 0;
  let queueChange = null; let staleQueueReads = 0;
  const deployedVersion = "22222222-2222-4222-8222-222222222222";
  const dependencies = {
    verify: async () => { events.push("verify"); },
    queue: async () => {
      if (queueChange === "pause" && options.malformedAfterPause) return { settings: { delivery_paused: "unknown" } };
      const neverVisible = queueChange === "pause" ? options.neverPauseVisible : queueChange === "resume" ? options.neverResumeVisible : false;
      const stale = queueChange && (neverVisible || staleQueueReads-- > 0);
      return { settings: { delivery_paused: stale ? !paused : paused } };
    },
    json: async args => {
      if (args[0] === "deployments") {
        if (deployed && options.splitTraffic) return [{ created_on: "2026-01-01T00:00:00Z", versions: [{ version_id: previousVersion, percentage: 50 }, { version_id: deployedVersion, percentage: 50 }] }];
        const observed = deployed && options.unexpectedAfterDeploy ? "33333333-3333-4333-8333-333333333333"
          : deployed && (options.neverVisible || staleReads-- > 0) ? previousVersion : version;
        return [{ created_on: "2026-01-01T00:00:00Z", versions: [{ version_id: observed, percentage: 100 }] }];
      }
      return [{ success: true, results: options.pendingMigration ? [] : [{ name: "0001.sql" }] }];
    },
    backup: async () => { events.push("backup"); if (options.backupFails) throw new Error("backup failed"); return { directory: join(root, "backups/fixture") }; },
    verifyBackup: async () => {
      events.push("verify-prepared-backup");
      return { manifest: { completedAt: new Date().toISOString(), database: { id: config.d1_databases[0].database_id, name: "ferto" }, origin: config.vars.APP_ORIGIN, workerVersion: options.staleBackup ? "older-version" : version, source: { revision: "a".repeat(40), dirty: false } } };
    },
    run: async args => {
      if (args[0] === "queues") {
        events.push(args[1]); paused = args[1] === "pause-delivery";
        queueChange = paused ? "pause" : "resume";
        staleQueueReads = (paused ? options.stalePauseReads : options.staleResumeReads) ?? 0;
        return "";
      }
      if (args[0] === "d1") { events.push("migrate"); if (options.migrationFails) throw new Error("migration failed"); return ""; }
      if (args[0] === "deploy") { events.push("deploy"); deployed = true; version = deployedVersion; return `Current Version ID: ${deployedVersion}`; }
      throw new Error("Unexpected command");
    },
    drain: async milliseconds => {
      events.push("drain"); assert.equal(milliseconds, 16 * 60000);
      if (options.changedArtifact) await writeFile(join(root, ".release/manifest.json"), JSON.stringify({ revision: "b".repeat(40), files: {} }));
      if (options.externalDeploy) version = "33333333-3333-4333-8333-333333333333";
    },
    wait: async milliseconds => { assert.equal(milliseconds, 5000); events.push("wait"); },
    smoke: async () => { events.push("smoke"); if (options.smokeFails) throw new Error("wrong assets"); if (options.staleBeforeResume) staleReads = 2; return { revision: "a".repeat(40) }; },
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

for (const options of [{ staleDeploymentReads: 2 }, { staleBeforeResume: true }]) {
  test(`stale deployment reads recover without repeating a write (${JSON.stringify(options)})`, async () => {
    const f = await fixture(options);
    try {
      assert.equal((await deployLocal(f)).status, "complete");
      assert.equal(f.events.filter(event => event === "wait").length, 2);
      assert.equal(f.events.filter(event => event === "deploy").length, 1);
      assert.equal(f.events.filter(event => event === "smoke").length, 1);
      assert.equal(f.events.at(-1), "resume-delivery"); assert.equal(f.paused(), false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const [name, options, waits] of [["persistently stale reads", { neverVisible: true }, 5], ["an unexpected Worker", { unexpectedAfterDeploy: true }, 0], ["split traffic", { splitTraffic: true }, 0]]) {
  test(`${name} stops confirmation and keeps delivery paused`, async () => {
    const f = await fixture(options);
    try {
      await assert.rejects(deployLocal(f), /Queue pause was requested/);
      assert.equal(f.events.filter(event => event === "wait").length, waits);
      assert.equal(f.events.filter(event => event === "deploy").length, 1);
      assert.ok(!f.events.includes("smoke")); assert.ok(!f.events.includes("resume-delivery"));
      assert.equal(f.paused(), true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const options of [{ stalePauseReads: 2 }, { staleResumeReads: 2 }]) {
  test(`Queue settings converge without repeating their mutation (${JSON.stringify(options)})`, async () => {
    const f = await fixture(options);
    try {
      assert.equal((await deployLocal(f)).status, "complete");
      assert.equal(f.events.filter(event => event === "wait").length, 2);
      for (const event of ["pause-delivery", "deploy", "smoke", "resume-delivery"]) assert.equal(f.events.filter(value => value === event).length, 1);
      assert.equal(f.paused(), false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const [name, options, waits, deploys] of [["unconfirmed pause", { neverPauseVisible: true }, 5, 0], ["unconfirmed resume", { neverResumeVisible: true }, 5, 1], ["invalid Queue setting", { malformedAfterPause: true }, 0, 0]]) {
  test(`${name} fails closed after bounded reads`, async () => {
    const f = await fixture(options);
    try {
      await assert.rejects(deployLocal(f), /Queue pause was requested/);
      assert.equal(f.events.filter(event => event === "wait").length, waits);
      assert.equal(f.events.filter(event => event === "deploy").length, deploys);
      assert.equal(f.events.filter(event => event === "resume-delivery").length, deploys);
      assert.equal(f.paused(), true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

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
