import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyBackup } from "./backup.mjs";
import { ignoredOutput, privateDirectory, privateFile, projectRoot } from "./operations-lib.mjs";

const exec = promisify(execFile);
const members = ["manifest.json", "instance.json", "database.sql.gz"];
const MAX_ARCHIVE_BYTES = 768 * 1024 * 1024;

async function run(command, args, options = {}) {
  try { return await exec(command, args, { maxBuffer: 2 * 1024 * 1024, timeout: 180_000, ...options }); }
  catch { throw new Error(`${command} failed; check its installation, key access and protected input files`); }
}

async function runToFile(command, args, destination) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise(resolveCode => { child.once("error", () => resolveCode(-1)); child.once("close", resolveCode); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  let bytes = 0;
  const bound = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > MAX_ARCHIVE_BYTES ? new Error("Decrypted archive exceeds the supported size") : null, chunk);
  } });
  try {
    await pipeline(child.stdout, bound, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    if (await exited !== 0) throw new Error("Archive decryption/extraction did not complete successfully");
  } catch { child.kill("SIGKILL"); await exited; throw new Error("Archive decryption/extraction did not complete successfully"); }
  finally { clearTimeout(timer); }
}

export async function createBackupKey({ root = projectRoot } = {}) {
  const home = await ignoredOutput(join(root, ".local/backup-key"), root);
  const recipient = join(home, "recipient.asc");
  try {
    await lstat(recipient);
    const info = await run("gpg", ["--batch", "--homedir", home, "--with-colons", "--list-secret-keys"]);
    if (!info.stdout.includes(":e:" ) && !info.stdout.includes("sec:")) throw new Error("Private backup key unavailable");
    return { home, recipient };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // A dedicated local keyring: no personal GPG profile, network or keyserver.
  await run("gpg", ["--batch", "--homedir", home, "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "FERTO CI backups", "default", "default", "0"]);
  const publicKey = await run("gpg", ["--batch", "--homedir", home, "--armor", "--export"]);
  const secretKey = await run("gpg", ["--batch", "--homedir", home, "--pinentry-mode", "loopback", "--passphrase", "", "--armor", "--export-secret-keys"]);
  await privateFile(recipient, publicKey.stdout);
  await privateFile(join(home, "recovery-private-key.asc"), secretKey.stdout);
  return { home, recipient };
}

export async function encryptDirectory(directory, { recipientFile, output, root = projectRoot, files } = {}) {
  const source = await privateDirectory(resolve(directory));
  const parent = await ignoredOutput(resolve(output, ".."), root);
  const work = await mkdtemp(join(parent, ".encrypt-")); await chmod(work, 0o700);
  const destination = resolve(output);
  let created = false;
  try {
    const keyHome = join(work, "gnupg"); await privateDirectory(keyHome);
    await run("gpg", ["--batch", "--homedir", keyHome, "--import", resolve(recipientFile)]);
    const keys = await run("gpg", ["--batch", "--homedir", keyHome, "--with-colons", "--list-keys"]);
    const fingerprints = keys.stdout.split("\n").filter(line => line.startsWith("fpr:")).map(line => line.split(":")[9]);
    if (!fingerprints.length) throw new Error("Backup recipient key is missing");
    const selected = files || ["."];
    // Reject links/special files before tar can include material outside this directory.
    const inspect = async path => {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("Encrypted operation input must contain only regular files/directories");
      if (info.isDirectory()) for (const name of await readdir(path)) await inspect(join(path, name));
    };
    for (const name of selected) {
      if (name !== "." && !members.includes(name)) throw new Error("Unexpected backup member");
      await inspect(join(source, name));
    }
    const payload = join(work, "payload.tar");
    await privateFile(payload, "");
    await run("tar", ["--create", "--file", payload, "--directory", source, "--", ...selected]);
    if ((await lstat(payload)).size > MAX_ARCHIVE_BYTES) throw new Error("Encrypted archive exceeds the supported size");
    await privateFile(destination, ""); created = true;
    await run("gpg", ["--batch", "--yes", "--homedir", keyHome, "--trust-model", "always", "--compress-algo", "none", "--cipher-algo", "AES256", "--recipient", fingerprints[0], "--output", destination, "--encrypt", payload]);
    return destination;
  } catch (error) { if (created) await rm(destination, { force: true }); throw error; }
  finally { await rm(work, { recursive: true, force: true }); }
}

export async function encryptBackup(directory, options) {
  await verifyBackup(directory);
  return encryptDirectory(directory, { ...options, files: members });
}

export async function restoreEncryptedBackup(file, { keyHome = join(projectRoot, ".local/backup-key"), output = join(projectRoot, "backups/ferto"), root = projectRoot } = {}) {
  const home = await privateDirectory(resolve(keyHome));
  const input = await lstat(file);
  if (!input.isFile() || input.isSymbolicLink() || input.size > MAX_ARCHIVE_BYTES) throw new Error("Use a regular encrypted backup within the supported size");
  const parent = await ignoredOutput(output, root);
  const work = await mkdtemp(join(parent, ".partial-ci-")); await chmod(work, 0o700);
  try {
    const payload = join(work, "payload.tar");
    // Finish integrity-checked decryption before processing any archive members.
    await runToFile("gpg", ["--batch", "--homedir", home, "--decrypt", resolve(file)], payload);
    if ((await lstat(payload)).size > MAX_ARCHIVE_BYTES) throw new Error("Decrypted backup exceeds the supported size");
    const listing = await run("tar", ["--list", "--verbose", "--numeric-owner", "--file", payload]);
    const lines = listing.stdout.trim().split("\n");
    const names = lines.map(line => line.trim().split(/\s+/).at(-1));
    if (lines.some(line => !line.startsWith("-")) || JSON.stringify([...names].sort()) !== JSON.stringify([...members].sort())) throw new Error("Encrypted backup contains unexpected, duplicate or unsafe archive members");
    for (const name of members) {
      // Stream only a fixed member to a file we create; never extract archive paths.
      await runToFile("tar", ["--extract", "--to-stdout", "--file", payload, "--", name], join(work, name));
    }
    await rm(payload);
    await verifyBackup(work, { allowPartial: true });
    const manifest = JSON.parse(await readFile(join(work, "manifest.json"), "utf8"));
    const destination = join(parent, `ci-${manifest.startedAt.replaceAll(/[:.]/g, "-")}-${work.split(".partial-ci-").at(-1)}`);
    await rename(work, destination);
    return { directory: destination, manifest };
  } catch (error) { await rm(work, { recursive: true, force: true }); throw error; }
}

export async function fetchCiBackup({ runId, repository, root = projectRoot, keyHome } = {}) {
  if (!/^\d+$/.test(String(runId))) throw new Error("Use a numeric GitHub workflow run ID");
  if (!repository) repository = (await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: root })).stdout.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Use an owner/repository GitHub name");
  const response = await run("gh", ["api", `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`], { cwd: root });
  const artifacts = JSON.parse(response.stdout).artifacts.filter(item => new RegExp(`^ferto-backup-${runId}-[0-9]+$`).test(item.name) && !item.expired).sort((a, b) => Number(b.name.split("-").at(-1)) - Number(a.name.split("-").at(-1)));
  if (!artifacts.length || artifacts[0].size_in_bytes > MAX_ARCHIVE_BYTES) throw new Error("No retained CI backup within the supported size exists for this run");
  const parent = await ignoredOutput(join(root, ".local/ci-downloads"), root);
  const folder = await mkdtemp(join(parent, "backup-")); await chmod(folder, 0o700);
  await run("gh", ["run", "download", String(runId), "--repo", repository, "--name", artifacts[0].name, "--dir", folder], { cwd: root });
  return restoreEncryptedBackup(join(folder, "backup.gpg"), { keyHome, output: join(root, "backups/ferto"), root });
}
