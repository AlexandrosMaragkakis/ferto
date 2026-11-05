import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assertProductionConfig } from "./deployment-config.mjs";

const template = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const populated = () => {
  const config = structuredClone(template);
  config.d1_databases[0].database_id = "11111111-2222-3333-4444-555555555555";
  config.vars = { SPOTIFY_CLIENT_ID: "fixture-client", OWNER_SPOTIFY_ID: "fixture-owner", APP_ORIGIN: "https://music.example.com" };
  return config;
};

test("the public template cannot be used as a production target", () => {
  assert.throws(() => assertProductionConfig(template), /Production configuration/);
  assert.doesNotThrow(() => assertProductionConfig(populated()));
  const replacement = populated(); replacement.d1_databases[0].database_name = "ferto-recovery-20261105";
  assert.doesNotThrow(() => assertProductionConfig(replacement));
  for (const origin of ["http://music.example.com", "https://localhost", "https://music.example.com/", "https://music.example.com/path"]) {
    const config = populated(); config.vars.APP_ORIGIN = origin;
    assert.throws(() => assertProductionConfig(config), /APP_ORIGIN/);
  }
  const config = populated(); config.vars.SESSION_SECRET = "fixture-value";
  assert.throws(() => assertProductionConfig(config), /Worker secrets/);
});

test("a template is rejected by production OAuth before opening a browser or storing a token", () => {
  const folder = mkdtempSync(join(tmpdir(), "ferto-config-"));
  try {
    const result = spawnSync(process.execPath, [new URL("./spotify-authorize.mjs", import.meta.url).pathname, "--production", "--config", new URL("../wrangler.jsonc", import.meta.url).pathname], { cwd: folder, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production configuration needs/);
    assert.doesNotMatch(result.stdout, /Open this URL/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("instance initialization writes private settings and refuses to replace an existing instance", () => {
  const folder = mkdtempSync(join(tmpdir(), "ferto-config-init-"));
  try {
    writeFileSync(join(folder, "wrangler.jsonc"), JSON.stringify(template));
    const env = { ...process.env, FERTO_DATABASE_ID: populated().d1_databases[0].database_id, ...populated().vars };
    const run = () => spawnSync(process.execPath, [new URL("./deployment-config.mjs", import.meta.url).pathname, "--init"], { cwd: folder, env, encoding: "utf8" });
    assert.equal(run().status, 0);
    const path = join(folder, "wrangler.production.jsonc"), original = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(original).vars, populated().vars);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(run().status, 1);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
