import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const available = spawnSync("timeout", ["--version"], { encoding: "utf8" }).status === 0;
async function fixture(body, check, timings = {}) {
  const folder = await mkdtemp(join(tmpdir(), "ferto-browser-install-"));
  try {
    await writeFile(join(folder, "node"), `#!/usr/bin/env bash\nset -eu\nCOUNT="$(dirname "$0")/count"\nn=0\nif [[ -f "$COUNT" ]]; then n=$(cat "$COUNT"); fi\nn=$((n+1))\nprintf '%s' "$n" > "$COUNT"\n${body}\n`, { mode: 0o700 });
    const result = spawnSync("bash", [resolve("scripts/install-browser.sh")], {
      encoding: "utf8", timeout: 12_000,
      env: { ...process.env, GITHUB_ACTIONS: "false", PLAYWRIGHT_BROWSERS_PATH: join(folder, "browsers"), PATH: `${folder}:${process.env.PATH}`, FERTO_BROWSER_INSTALL_TIMEOUT_SECONDS: "1", FERTO_BROWSER_INSTALL_KILL_SECONDS: "1", FERTO_BROWSER_INSTALL_RETRY_SECONDS: "0", ...timings },
    });
    const count = await readFile(join(folder, "count"), "utf8").catch(() => "0");
    check(result, Number(count));
  } finally { await rm(folder, { recursive: true, force: true }); }
}

test("a successful first installation is not repeated", { skip: !available }, async () => {
  await fixture("exit 0", (result, count) => { assert.equal(result.status, 0); assert.equal(count, 1); });
});
test("a transient installer failure retries and succeeds", { skip: !available }, async () => {
  await fixture('if (( n == 1 )); then echo "temporary mirror failure" >&2; exit 7; fi', (result, count) => {
    assert.equal(result.status, 0); assert.equal(count, 2);
    assert.match(result.stderr, /temporary mirror failure/);
    assert.match(result.stdout, /Browser installation completed/);
  });
});
test("persistent failure exits nonzero after exactly two attempts", { skip: !available }, async () => {
  await fixture("exit 9", (result, count) => {
    assert.equal(result.status, 9); assert.equal(count, 2);
    assert.match(result.stderr, /verification cannot continue/);
  });
});
test("hung installers and children that ignore TERM are killed within the bound", { skip: !available }, async () => {
  const start = Date.now();
  await fixture("trap '' TERM\nsleep 30", (result, count) => {
    assert.equal(result.error, undefined); assert.equal(result.status, 137); assert.equal(count, 2);
    assert.ok(Date.now() - start < 10_000);
  });
});
test("invalid or enlarged timing overrides stop before launching the installer", { skip: !available }, async () => {
  for (const timings of [{ FERTO_BROWSER_INSTALL_TIMEOUT_SECONDS: "121" }, { FERTO_BROWSER_INSTALL_RETRY_SECONDS: "11" }, { FERTO_BROWSER_INSTALL_KILL_SECONDS: "0" }, { FERTO_BROWSER_INSTALL_TIMEOUT_SECONDS: "bad" }]) {
    await fixture("exit 0", (result, count) => { assert.equal(result.status, 2); assert.equal(count, 0); }, timings);
  }
});

const sudoAvailable = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0;
test("CI timeout also terminates root-owned installer children before retrying", { skip: !available || !sudoAvailable }, async () => {
  await fixture("if (( EUID != 0 )); then exit 88; fi\ntrap '' TERM\nsleep 30", (result, count) => {
    assert.equal(result.error, undefined); assert.equal(result.status, 137); assert.equal(count, 2);
  }, { GITHUB_ACTIONS: "true" });
});
