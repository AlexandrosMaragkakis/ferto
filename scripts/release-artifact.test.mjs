import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-release-artifact.mjs", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
test("release artifacts require a clean matching revision, runtime, lockfile and exact file checksums", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "ferto-release-test-"));
  try {
    const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd: folder, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q");
    await writeFile(join(folder, "package-lock.json"), "{}\n");
    await writeFile(join(folder, ".gitignore"), ".release/\n");
    git("add", "package-lock.json", ".gitignore");
    git("-c", "user.name=Release Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture");
    await mkdir(join(folder, ".release/worker"), { recursive: true });
    const worker = "export default {};\n";
    await writeFile(join(folder, ".release/worker/worker.js"), worker);
    const manifest = { revision: git("rev-parse", "HEAD"), dirty: false, node: process.version,
      lockfile: hash(await readFile(join(folder, "package-lock.json"))), files: { "worker/worker.js": hash(worker) } };
    const save = (value) => writeFile(join(folder, ".release/manifest.json"), JSON.stringify(value));
    const check = () => spawnSync(process.execPath, [checker], { cwd: folder, encoding: "utf8" });
    await t.test("accepts an intact artifact", async () => { await save(manifest); assert.equal(check().status, 0); });
    await t.test("rejects worktree edits made after packaging", async () => {
      await writeFile(join(folder, "new-source.mjs"), "export default 1;\n"); assert.equal(check().status, 1);
      await rm(join(folder, "new-source.mjs"));
    });
    for (const [label, change] of [
      ["dirty", { dirty: true }], ["revision", { revision: "0".repeat(40) }],
      ["runtime", { node: "v0.0.0" }], ["lockfile", { lockfile: "0".repeat(64) }],
    ]) await t.test(`rejects a mismatched ${label}`, async () => { await save({ ...manifest, ...change }); assert.equal(check().status, 1); });
    await save(manifest);
    await t.test("rejects modified bytes", async () => {
      await writeFile(join(folder, ".release/worker/worker.js"), "tampered"); assert.equal(check().status, 1);
      await writeFile(join(folder, ".release/worker/worker.js"), worker);
    });
    await t.test("rejects unverified extra deployable files", async () => {
      await writeFile(join(folder, ".release/extra.js"), "extra"); assert.equal(check().status, 1);
    });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("valid checksums cannot redirect a production release outside its artifact", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ferto-contained-release-"));
  try {
    const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: folder, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q"); await writeFile(join(folder, ".gitignore"), ".release/\n"); await writeFile(join(folder, "package-lock.json"), "{}\n");
    await writeFile(join(folder, "outside.mjs"), "export default {};\n");
    git("add", "."); git("-c", "user.name=Release Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture");
    for (const name of ["worker", "assets", "migrations"]) await mkdir(join(folder, ".release", name), { recursive: true });
    const bodies = { "worker/worker.js": "export default {};\n", "assets/index.html": "FERTO", "migrations/0001.sql": "SELECT 1;" };
    for (const [file, body] of Object.entries(bodies)) await writeFile(join(folder, ".release", file), body);
    const config = { name: "ferto", main: "worker/worker.js", assets: { directory: "./assets" }, vars: { SPOTIFY_CLIENT_ID: "fixture", OWNER_SPOTIFY_ID: "owner", APP_ORIGIN: "https://ferto.example.com" },
      d1_databases: [{ binding: "DB", database_name: "ferto", database_id: "11111111-1111-4111-8111-111111111111", migrations_dir: "migrations" }],
      queues: { producers: [{ queue: "ferto-refresh" }], consumers: [{ queue: "ferto-refresh" }] } };
    const check = async cfg => {
      const configText = JSON.stringify(cfg); await writeFile(join(folder, ".release/wrangler.jsonc"), configText);
      const files = Object.fromEntries(Object.entries({ ...bodies, "wrangler.jsonc": configText }).map(([file, body]) => [file, hash(body)]));
      await writeFile(join(folder, ".release/manifest.json"), JSON.stringify({ revision: git("rev-parse", "HEAD"), dirty: false, node: process.version, lockfile: hash("{}\n"), files }));
      return spawnSync(process.execPath, [checker, "--production"], { cwd: folder, encoding: "utf8" });
    };
    assert.equal((await check(config)).status, 0);
    for (const mutate of [cfg => { cfg.main = "../outside.mjs"; }, cfg => { cfg.assets.directory = "../outside-assets"; }, cfg => { cfg.d1_databases[0].migrations_dir = "../outside-migrations"; }]) {
      const invalid = structuredClone(config); mutate(invalid); assert.equal((await check(invalid)).status, 1);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
