import { chmod, lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashFile } from "./backup.mjs";
import { assertCiContext, confirmSavedBackup } from "./deploy-ci.mjs";
import { projectRoot } from "./operations-lib.mjs";
import { downloadCiArtifact } from "./download-ci-artifact.mjs";

/** Use GitHub's REST-backed CLI when a just-uploaded artifact is not yet
 * visible to the action backend. Only download failures retry; changed or
 * incomplete ciphertext fails closed before delivery can be paused. */
export async function downloadSavedBackup({ root = projectRoot, repository = process.env.GITHUB_REPOSITORY,
  runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT,
  artifactId = process.env.FERTO_BACKUP_ARTIFACT_ID, execute, wait, log } = {}) {
  if (!/^[\w-]+\/[\w.-]+$/.test(repository || "") || [runId, attempt, artifactId].some(value => !/^[1-9]\d*$/.test(value || ""))) throw new Error("Saved backup needs the exact repository, run, attempt and upload ID");
  const saved = JSON.parse(await readFile(join(root, ".local/ci/backup.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/.test(saved.sha256) || !Number.isSafeInteger(saved.bytes) || saved.bytes < 1 || saved.bytes > 768 * 1024 * 1024) throw new Error("Invalid saved backup size/checksum");
  await downloadCiArtifact({ root, repository, runId, name: `ferto-backup-${runId}-${attempt}`,
    destination: ".local/ci-roundtrip", execute, wait, log, validate: async stage => {
      const file = join(stage, "backup.gpg");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== saved.bytes || (await readdir(stage)).join() !== "backup.gpg" || await hashFile(file) !== saved.sha256) throw new Error("Downloaded encrypted backup differs from the verified export");
      await chmod(file, 0o600);
    } });
  return confirmSavedBackup({ root, artifactId });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try { assertCiContext(); await downloadSavedBackup(); console.log("Saved backup downloaded and exact ciphertext size/checksum verified."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
