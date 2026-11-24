import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashFile } from "./backup.mjs";
import { assertCiContext, confirmSavedBackup } from "./deploy-ci.mjs";
import { ignoredOutput, projectRoot } from "./operations-lib.mjs";

const exec = promisify(execFile);
const download = (command, args) => exec(command, args, { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
  env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN } });

/** Use GitHub's REST-backed CLI when a just-uploaded artifact is not yet
 * visible to the action backend. Only download failures retry; changed or
 * incomplete ciphertext fails closed before delivery can be paused. */
export async function downloadSavedBackup({ root = projectRoot, repository = process.env.GITHUB_REPOSITORY,
  runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT,
  artifactId = process.env.FERTO_BACKUP_ARTIFACT_ID, execute = download,
  wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms)), log = console.log } = {}) {
  if (!/^[\w-]+\/[\w.-]+$/.test(repository || "") || [runId, attempt, artifactId].some(value => !/^[1-9]\d*$/.test(value || ""))) throw new Error("Saved backup needs the exact repository, run, attempt and upload ID");
  const parent = await ignoredOutput(join(root, ".local/ci-download"), root);
  const destination = join(root, ".local/ci-roundtrip");
  if (await lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; })) throw new Error("Backup round-trip destination already exists");
  const saved = JSON.parse(await readFile(join(root, ".local/ci/backup.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/.test(saved.sha256) || !Number.isSafeInteger(saved.bytes) || saved.bytes < 1 || saved.bytes > 768 * 1024 * 1024) throw new Error("Invalid saved backup size/checksum");
  for (let retry = 1; retry <= 3; retry++) {
    const stage = await mkdtemp(join(parent, "download-")); await chmod(stage, 0o700);
    try {
      log(`Backup artifact download attempt ${retry}/3.`);
      try {
        await execute("gh", ["run", "download", runId, "--repo", repository, "--name", `ferto-backup-${runId}-${attempt}`, "--dir", stage]);
      } catch {
        if (retry === 3) throw new Error("Saved backup could not be downloaded after three bounded attempts; deployment cannot continue");
        await wait(retry * 5000);
        continue;
      }
      const file = join(stage, "backup.gpg");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== saved.bytes || (await readdir(stage)).join() !== "backup.gpg" || await hashFile(file) !== saved.sha256) throw new Error("Downloaded encrypted backup differs from the verified export");
      await chmod(file, 0o600);
      await rename(stage, destination);
      return await confirmSavedBackup({ root, artifactId });
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try { assertCiContext(); await downloadSavedBackup(); console.log("Saved backup downloaded and exact ciphertext size/checksum verified."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
