import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const script = new URL("./check-secrets.mjs", import.meta.url).pathname;
function fixture(run) {
  const folder = mkdtempSync(join(tmpdir(), "ferto-scan-test-"));
  const git = args => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: folder, stdio: "ignore" });
  const write = (name, content) => writeFileSync(join(folder, name), content);
  const scan = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: folder, encoding: "utf8" });
  try {
    git(["init", "-q"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.invalid"]);
    write(".gitignore", ".dev.vars\n.release/\n"); write("app.txt", "public fixture\n");
    git(["add", "."]); git(["commit", "-qm", "Initial fixture"]);
    run({ folder, git, write, scan });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test("clean working contents and history pass with the pinned scanner", () => fixture(({ scan }) => {
  const result = scan(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Secret check passed/);
}));

test("known opaque credentials remain detectable after removal from HEAD; output is redacted", () => fixture(({ git, write, scan }) => {
  const secret = randomBytes(36).toString("base64url");
  write(".dev.vars", `SPOTIFY_REFRESH_TOKEN=${secret}\n`);
  write("app.txt", secret); git(["add", "app.txt"]); git(["commit", "-qm", "Accidental credential"]);
  write("app.txt", "clean now\n"); git(["add", "app.txt"]); git(["commit", "-qm", "Remove credential"]);
  const result = scan("--ref", "HEAD");
  assert.equal(result.status, 1); assert.match(result.stderr, /Known local credential: history blob/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
}));

test("exact-commit scanning excludes untracked files while working-tree scanning includes them", () => fixture(({ write, scan }) => {
  write("wrangler.production.jsonc", "{}\n");
  assert.equal(scan("--ref", "HEAD").status, 0);
  const result = scan(); assert.equal(result.status, 1); assert.match(result.stderr, /Private\/generated path/);
}));

test("force-tracked local credentials are blocked even when Git ignores them", () => fixture(({ git, write, scan }) => {
  write(".dev.vars", "OWNER_SPOTIFY_ID=fixture\n"); git(["add", "-f", ".dev.vars"]);
  const result = scan(); assert.equal(result.status, 1); assert.match(result.stderr, /Private\/generated path.*\.dev.vars/);
}));

test("compressed database exports are blocked even outside the normal backup folder", () => fixture(({ git, write, scan }) => {
  write("database.sql.gz", gzipSync("private catalogue fixture with no recognizable credential"));
  git(["add", "-f", "database.sql.gz"]);
  const result = scan(); assert.equal(result.status, 1); assert.match(result.stderr, /Private\/generated path.*database\.sql\.gz/);
}));

test("keys, encrypted backups, logs and superseded planning files cannot be force-published", () => fixture(({ git, write, scan }) => {
  for (const name of ["backup-key.asc", "backup.gpg", "debug.log", "initial_prompt.md"]) {
    write(name, "local-only fixture without a recognizable secret"); git(["add", "-f", name]);
  }
  const result = scan(); assert.equal(result.status, 1);
  for (const name of ["backup-key.asc", "backup.gpg", "debug.log", "initial_prompt.md"]) assert.ok(result.stderr.includes(name));
}));

test("credentials in release artifacts are detected without printing their values", () => fixture(({ folder, write, scan }) => {
  const secret = randomBytes(36).toString("base64url");
  write(".dev.vars", `SESSION_SECRET=${secret}\n`); mkdirSync(join(folder, ".release")); write(".release/worker.js", secret);
  const result = scan("--ref", "HEAD", "--artifact", ".release");
  assert.equal(result.status, 1); assert.match(result.stderr, /Known local credential: artifact/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
}));

test("symbolic links cannot pull files outside the proposed public tree", () => fixture(({ folder, scan }) => {
  symlinkSync(script, join(folder, "outside.mjs"));
  const result = scan(); assert.equal(result.status, 1); assert.match(result.stderr, /Unsupported link/);
}));

test("Gitleaks detects credentials that are absent from the local secret inventory", () => fixture(({ write, scan }) => {
  const secret = "gh" + "p_" + randomBytes(30).toString("hex").slice(0, 36);
  write("accident.txt", secret + " # gitleaks:allow\n");
  write(".gitleaks.toml", '[[rules]]\nid = "dummy"\nregex = "never-match-fixture"\n');
  const result = scan(); assert.equal(result.status, 1); assert.match(result.stderr, /Gitleaks github-pat/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
}));
