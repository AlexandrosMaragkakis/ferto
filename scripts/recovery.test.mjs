import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import maintenance from "../ops/maintenance-worker.mjs";
import { prepareRecovery } from "./prepare-recovery.mjs";

test("maintenance rejects requests and retries messages without touching D1", async () => {
  const response = maintenance.fetch(new Request("https://ferto.example.com/api/owner/like", { method: "POST" }));
  assert.equal(response.status, 503); assert.equal(response.headers.get("Cache-Control"), "no-store");
  let retry; maintenance.queue({ retryAll: options => { retry = options; } });
  assert.deepEqual(retry, { delaySeconds: 900 });
  assert.equal(maintenance.scheduled(), undefined);
});

test("recovery preparation is local, preserves the instance file and disables assets/crons", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferto-recovery-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".local/\n");
    const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    config.vars = { SPOTIFY_CLIENT_ID: "fixture", OWNER_SPOTIFY_ID: "owner", APP_ORIGIN: "https://ferto.example.com" };
    config.d1_databases[0].database_id = "11111111-1111-4111-8111-111111111111";
    const file = join(root, "instance.json"); const original = JSON.stringify(config); await writeFile(file, original);
    const output = await prepareRecovery({ configFile: file, root });
    const prepared = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(prepared.triggers.crons, []); assert.equal(prepared.assets, undefined);
    assert.equal(prepared.main, join(root, "ops/maintenance-worker.mjs"));
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(prepared.d1_databases[0].database_id, config.d1_databases[0].database_id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
