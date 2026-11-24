import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ignoredOutput, projectRoot } from "./operations-lib.mjs";

const exec = promisify(execFile);
const download = (command, args) => exec(command, args, { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
  env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN } });

/** The action backend may not immediately list a newly uploaded artifact.
 * Retry REST-backed downloads in fresh private staging directories. Callers
 * retain their integrity checks; validation failures never trigger retries. */
export async function downloadCiArtifact({ root = projectRoot, repository = process.env.GITHUB_REPOSITORY,
  runId = process.env.GITHUB_RUN_ID, name, destination, execute = download,
  validate = async () => {}, wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms)), log = console.log } = {}) {
  if (!/^[\w-]+\/[\w.-]+$/.test(repository || "") || !/^[1-9]\d*$/.test(runId || "") || !/^[\w.-]+$/.test(name || "")
    || ![".release", ".local/ci-roundtrip"].includes(destination)) throw new Error("Artifact download needs the exact repository, run, name and supported destination");
  const parent = await ignoredOutput(join(root, ".local/ci-download"), root);
  const output = join(root, destination);
  if (await lstat(output).catch(error => { if (error.code !== "ENOENT") throw error; })) throw new Error("Artifact round-trip destination already exists");
  for (let retry = 1; retry <= 3; retry++) {
    const stage = await mkdtemp(join(parent, "download-")); await chmod(stage, 0o700);
    try {
      log(`Artifact download attempt ${retry}/3.`);
      try { await execute("gh", ["run", "download", runId, "--repo", repository, "--name", name, "--dir", stage]); }
      catch {
        if (retry === 3) throw new Error("Artifact could not be downloaded after three bounded attempts; verification cannot continue");
        await wait(retry * 5000); continue;
      }
      await validate(stage);
      await rename(stage, output);
      return output;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try { await downloadCiArtifact({ name: "verified-release", destination: ".release" }); console.log("Release artifact downloaded; revision/checksum validation must pass next."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
