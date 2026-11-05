import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createBackup, verifyBackup } from "./backup.mjs";
import { createBackupKey, encryptBackup, encryptDirectory, restoreEncryptedBackup } from "./backup-encryption.mjs";
import { sealRecoveryEvidence } from "./deploy-ci.mjs";

const sql = `CREATE TABLE d1_migrations(id INTEGER,name TEXT); INSERT INTO d1_migrations VALUES(1,'0001.sql');
CREATE TABLE recordings(title TEXT); INSERT INTO recordings VALUES('PRIVATE BACKUP FIXTURE');
CREATE TABLE refresh_state(singleton INTEGER,live_generation TEXT,candidate_count INTEGER,live_bucket_count INTEGER); INSERT INTO refresh_state VALUES(1,'live',1,1);
CREATE TABLE recommendation_slots(generation TEXT); INSERT INTO recommendation_slots VALUES('live');
CREATE TABLE recommendation_buckets(generation TEXT); INSERT INTO recommendation_buckets VALUES('live');
CREATE TABLE owner_sessions(hash TEXT); CREATE TABLE never_recordings(key TEXT); CREATE TABLE oauth_states(hash TEXT); CREATE TABLE request_budgets(key TEXT); CREATE TABLE rebuild_jobs(generation TEXT);`;

test("real OpenPGP backup encryption restores privately, rejects tampering/unsafe members, and keeps old copies", async t => {
  const root = await mkdtemp(join(tmpdir(), "ferto-encryption-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".local/\nbackups/\n");
    const configFile = join(root, "instance.json");
    await writeFile(configFile, JSON.stringify({ name: "ferto", vars: { SPOTIFY_CLIENT_ID: "fixture", OWNER_SPOTIFY_ID: "owner", APP_ORIGIN: "https://ferto.example.com" }, d1_databases: [{ binding: "DB", database_id: "11111111-1111-4111-8111-111111111111", database_name: "ferto" }], queues: { producers: [{ queue: "ferto-refresh" }], consumers: [{ queue: "ferto-refresh" }] } }));
    const original = await createBackup({ root, configFile, output: join(root, "backups/ferto"), runner: async args => { await writeFile(args[args.indexOf("--output") + 1], sql); }, jsonRunner: async args => args[0] === "deployments" ? [{ created_on: "2026-01-01", versions: [{ version_id: "fixture", percentage: 100 }] }] : {} });
    const key = await createBackupKey({ root });
    assert.equal((await stat(key.home)).mode & 0o777, 0o700);
    assert.equal((await stat(join(key.home, "recovery-private-key.asc"))).mode & 0o777, 0o600);
    const fingerprint = await readFile(key.recipient, "utf8");
    await createBackupKey({ root }); assert.equal(await readFile(key.recipient, "utf8"), fingerprint);
    const output = join(root, ".local/upload/backup.gpg");
    await encryptBackup(original.directory, { root, recipientFile: key.recipient, output });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(output)).includes(Buffer.from("PRIVATE BACKUP FIXTURE")));
    const restore = () => restoreEncryptedBackup(output, { root, keyHome: key.home, output: join(root, "backups/ferto") });
    await t.test("failed backup diagnostics are retained only inside encrypted recovery evidence", async () => {
      await mkdir(join(root, ".local/ci"), { mode: 0o700 }); await writeFile(join(root, ".local/ci/recipient.asc"), await readFile(key.recipient));
      const partial = join(root, "backups/ferto/.partial-failed"); await mkdir(partial, { mode: 0o700 });
      await writeFile(join(partial, "export.log"), "PRIVATE EXPORT DIAGNOSTIC");
      const sealed = await sealRecoveryEvidence({ root });
      assert.ok(!(await readFile(sealed)).includes(Buffer.from("PRIVATE EXPORT DIAGNOSTIC")));
      const decrypted = execFileSync("gpg", ["--batch", "--homedir", key.home, "--decrypt", sealed], { stdio: ["ignore", "pipe", "ignore"] });
      assert.ok(decrypted.includes(Buffer.from("PRIVATE EXPORT DIAGNOSTIC")));
      assert.ok(!decrypted.includes(Buffer.from("PRIVATE KEY BLOCK")));
      await rm(partial, { recursive: true });
    });
    await t.test("completed ciphertext restores and independently verifies the original database", async () => {
      const result = await restore();
      assert.deepEqual(result.manifest.verification, original.manifest.verification);
      assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
      assert.equal((await verifyBackup(result.directory)).verification.integrity, "ok");
    });
    await t.test("a keyring without the private key cannot restore the backup", async () => {
      const empty = join(root, ".local/empty-key"); await mkdir(empty, { mode: 0o700 });
      await assert.rejects(restoreEncryptedBackup(output, { root, keyHome: empty, output: join(root, "backups/ferto") }), /did not complete/);
    });
    await t.test("altered ciphertext is rejected without deleting the original good backup", async () => {
      const bytes = await readFile(output); const bad = Buffer.from(bytes); bad[Math.floor(bad.length / 2)] ^= 0xff;
      await writeFile(output, bad); await assert.rejects(restore(), /did not complete/); await writeFile(output, bytes);
      await verifyBackup(original.directory);
    });
    await t.test("arbitrary archive paths cannot be extracted", async () => {
      const unsafe = join(root, ".local/unsafe"); await mkdir(unsafe, { mode: 0o700 });
      await writeFile(join(unsafe, "unrelated.txt"), "must not extract");
      const encrypted = join(root, ".local/upload/unsafe.gpg");
      await encryptDirectory(unsafe, { root, recipientFile: key.recipient, output: encrypted });
      await assert.rejects(restoreEncryptedBackup(encrypted, { root, keyHome: key.home, output: join(root, "backups/ferto") }), /unsafe archive members/);
      assert.ok(!(await readdir(join(root, "backups/ferto"))).some(name => name.startsWith(".partial-")));
    });
  } finally {
    try { execFileSync("gpgconf", ["--homedir", join(root, ".local/backup-key"), "--kill", "gpg-agent"], { stdio: "ignore" }); } catch { /* Temp keyring only. */ }
    await rm(root, { recursive: true, force: true });
  }
});
