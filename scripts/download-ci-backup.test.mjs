import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadSavedBackup } from "./download-ci-backup.mjs";

async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), "ferto-backup-handoff-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(join(root, ".gitignore"), "/.local/\n");
    await mkdir(join(root, ".local/ci"), { recursive: true });
    const body = "ciphertext-fixture";
    await writeFile(join(root, ".local/ci/backup.json"), JSON.stringify({ directory: "/verified-export", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") }));
    const options = { root, repository: "fixture/ferto", runId: "42", attempt: "2", artifactId: "123", log() {} };
    await check({ root, body, options });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("delayed artifact visibility retries into fresh directories and preserves exact saved ciphertext", () => fixture(async ({ root, body, options }) => {
  const stages = []; const waits = [];
  const result = await downloadSavedBackup({ ...options, wait: async ms => { waits.push(ms); }, execute: async (command, args) => {
    assert.equal(command, "gh"); assert.deepEqual(args.slice(0, 8), ["run", "download", "42", "--repo", "fixture/ferto", "--name", "ferto-backup-42-2", "--dir"]);
    stages.push(args.at(-1)); await writeFile(join(args.at(-1), "backup.gpg"), body);
    if (stages.length < 3) throw new Error("Artifact is not visible yet");
  } });
  assert.equal(result.artifactId, "123"); assert.equal(result.directory, "/verified-export");
  assert.deepEqual(waits, [5000, 10000]); assert.equal(new Set(stages).size, 3);
  assert.equal(await readFile(join(root, ".local/ci-roundtrip/backup.gpg"), "utf8"), body);
  assert.deepEqual(await readdir(join(root, ".local/ci-download")), []);
}));

test("persistent download failures stop after three attempts without publishing a round trip", () => fixture(async ({ root, options }) => {
  let calls = 0;
  await assert.rejects(downloadSavedBackup({ ...options, wait: async () => {}, execute: async () => { calls++; throw new Error("private provider diagnostic"); } }), /three bounded attempts/);
  assert.equal(calls, 3); await assert.rejects(readFile(join(root, ".local/ci-roundtrip/backup.gpg")), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(root, ".local/ci-download")), []);
}));

test("altered or additional artifact contents fail before publication without retrying integrity failures", () => fixture(async ({ root, body, options }) => {
  for (const extra of [false, true]) {
    let calls = 0;
    await assert.rejects(downloadSavedBackup({ ...options, execute: async (_command, args) => {
      calls++; await writeFile(join(args.at(-1), "backup.gpg"), extra ? body : "x".repeat(body.length));
      if (extra) await writeFile(join(args.at(-1), "unexpected"), "extra");
    } }), /differs from the verified export/);
    assert.equal(calls, 1); await assert.rejects(readFile(join(root, ".local/ci-roundtrip/backup.gpg")), { code: "ENOENT" });
  }
}));

test("invalid artifact identity never starts a provider request", () => fixture(async ({ options }) => {
  for (const change of [{ repository: "../wrong" }, { runId: "" }, { attempt: "0" }, { artifactId: "unknown" }]) {
    await assert.rejects(downloadSavedBackup({ ...options, ...change, wait: async () => {}, execute: async () => assert.fail("Provider must not be contacted") }), /exact repository/);
  }
}));

test("an existing round-trip directory is retained and never overwritten", () => fixture(async ({ root, options }) => {
  await mkdir(join(root, ".local/ci-roundtrip")); await writeFile(join(root, ".local/ci-roundtrip/backup.gpg"), "existing");
  await assert.rejects(downloadSavedBackup({ ...options, execute: async () => assert.fail("Provider must not be contacted") }), /already exists/);
  assert.equal(await readFile(join(root, ".local/ci-roundtrip/backup.gpg"), "utf8"), "existing");
}));
