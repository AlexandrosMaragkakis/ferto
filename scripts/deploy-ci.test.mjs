import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertCiContext, assertCurrentMain, confirmSavedBackup, instanceConfig, targetRelease } from "./deploy-ci.mjs";
import { assertPreparedBackup } from "./deploy-local.mjs";
import { queueState } from "./operations-lib.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const instance = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111", databaseName: "ferto", spotifyClientId: "fixture", ownerSpotifyId: "owner", origin: "https://ferto.example.com" };
const template = { name: "ferto", main: "src/worker.ts", assets: { directory: "dist" }, vars: { APP_ORIGIN: "https://template.example.com" }, d1_databases: [{ binding: "DB", database_name: "ferto", database_id: "00000000-0000-0000-0000-000000000000" }], queues: { producers: [{ queue: "ferto-refresh" }], consumers: [{ queue: "ferto-refresh" }] } };
const context = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "fixture/ferto", FERTO_DEPLOY_REPOSITORY: "fixture/ferto", GITHUB_SHA: "a".repeat(40), GITHUB_TOKEN: "test-only" };

test("production guard refuses PRs, forks, other branches and missing CI identity", () => {
  assertCiContext(context);
  for (const change of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "pull_request_target" }, { GITHUB_REPOSITORY: "fork/ferto" }, { GITHUB_REF: "refs/heads/topic" }, { GITHUB_ACTIONS: "false" }, { GITHUB_SHA: "unknown" }]) assert.throws(() => assertCiContext({ ...context, ...change }));
  assertCiContext({ ...context, GITHUB_EVENT_NAME: "workflow_dispatch" });
});

test("CI instance settings cannot inject credentials or change resource structure", () => {
  const config = instanceConfig(template, instance); assert.equal(config.account_id, instance.accountId); assert.equal(config.vars.APP_ORIGIN, instance.origin);
  assert.throws(() => instanceConfig(template, { ...instance, SESSION_SECRET: "never accepted" }));
  assert.throws(() => instanceConfig(template, { ...instance, accountId: "" }));
  assert.throws(() => instanceConfig(template, { ...instance, origin: "http://localhost" }));
});

test("an explicit account and scoped CI token can inspect the Queue without listing user accounts", async () => {
  const previous = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    process.env.CLOUDFLARE_API_TOKEN = "scoped-fixture"; delete process.env.CLOUDFLARE_ACCOUNT_ID;
    globalThis.fetch = async url => { calls++; assert.ok(String(url).includes(`/accounts/${instance.accountId}/queues`)); return Response.json({ success: true, result: calls === 1 ? [{ queue_name: "ferto-refresh", queue_id: "fixture-queue" }] : { settings: { delivery_paused: false } } }); };
    const result = await queueState({ config: instanceConfig(template, instance), configFile: "/not-a-wrangler-install/config.json" }, "/not-a-log-directory");
    assert.equal(result.settings.delivery_paused, false); assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = previous;
    if (account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = account;
  }
});

test("a prepared backup must match the current Worker, instance, clean source and freshness", () => {
  const target = { config: instanceConfig(template, instance) };
  const manifest = { completedAt: new Date().toISOString(), database: { id: instance.databaseId, name: instance.databaseName }, origin: instance.origin, workerVersion: "current", source: { revision: context.GITHUB_SHA, dirty: false } };
  assertPreparedBackup(manifest, target, context.GITHUB_SHA, "current");
  for (const change of [{ completedAt: new Date(Date.now() - 7200000).toISOString() }, { workerVersion: "old" }, { origin: "https://other.example.com" }, { database: { id: "other", name: "ferto" } }, { source: { revision: context.GITHUB_SHA, dirty: true } }, { source: { revision: "b".repeat(40), dirty: false } }]) assert.throws(() => assertPreparedBackup({ ...manifest, ...change }, target, context.GITHUB_SHA, "current"));
});

test("CI verifies saved ciphertext and rejects missing uploads or altered downloaded bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferto-saved-backup-"));
  try {
    await mkdir(join(root, ".local/ci"), { recursive: true }); await mkdir(join(root, ".local/ci-roundtrip"));
    const body = "encrypted-fixture";
    await writeFile(join(root, ".local/ci/backup.json"), JSON.stringify({ directory: "private/backup", sha256: hash(body), bytes: body.length }));
    await writeFile(join(root, ".local/ci-roundtrip/backup.gpg"), body);
    assert.equal((await confirmSavedBackup({ root, artifactId: "123" })).artifactId, "123");
    await assert.rejects(confirmSavedBackup({ root, artifactId: "" }), /did not confirm/);
    await writeFile(join(root, ".local/ci-roundtrip/backup.gpg"), "altered");
    await assert.rejects(confirmSavedBackup({ root, artifactId: "123" }), /differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("targeting changes only reviewed instance configuration and four metadata URLs; stale runs cannot deploy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferto-ci-target-"));
  try {
    const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q"); await writeFile(join(root, ".gitignore"), ".local/\n.release/\nwrangler.production.jsonc\n");
    await writeFile(join(root, "package-lock.json"), "{}\n"); await writeFile(join(root, "wrangler.jsonc"), JSON.stringify(template));
    await mkdir(join(root, "scripts"));
    for (const name of ["check-release-artifact.mjs", "deployment-config.mjs"]) await cp(new URL(name, import.meta.url), join(root, "scripts", name));
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture");
    const revision = git("rev-parse", "HEAD");
    const files = { "wrangler.jsonc": JSON.stringify(template), "worker/worker.js": "export default {};\n", "assets/index.html": Array(4).fill('<meta content="https://template.example.com/">').join("\n"), "migrations/0001.sql": "SELECT 1;" };
    for (const folder of ["worker", "assets", "migrations"]) await mkdir(join(root, ".release", folder), { recursive: true });
    for (const [name, body] of Object.entries(files)) await writeFile(join(root, ".release", name), body);
    await writeFile(join(root, ".release/manifest.json"), JSON.stringify({ revision, dirty: false, node: process.version, lockfile: hash("{}\n"), files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, hash(body)])) }));
    await targetRelease({ root, instance, recipient: "-----BEGIN PGP PUBLIC KEY BLOCK-----\nfixture" });
    assert.equal(await readFile(join(root, ".release/worker/worker.js"), "utf8"), files["worker/worker.js"]);
    assert.equal(await readFile(join(root, ".release/migrations/0001.sql"), "utf8"), files["migrations/0001.sql"]);
    assert.ok(!(await readFile(join(root, ".release/assets/index.html"), "utf8")).includes("template.example.com"));
    assert.equal(git("status", "--porcelain"), "");
    const env = { ...context, GITHUB_SHA: revision };
    await assertCurrentMain({ root, env, fetchImpl: async () => Response.json({ object: { sha: revision } }) });
    await assert.rejects(assertCurrentMain({ root, env, fetchImpl: async () => Response.json({ object: { sha: "old" } }) }), /superseded/);
    await assert.rejects(assertCurrentMain({ root, env: { ...env, GITHUB_SHA: "b".repeat(40) }, fetchImpl: async () => { throw new Error("must not fetch"); } }), /checkout/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
