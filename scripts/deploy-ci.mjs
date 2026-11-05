import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBackup, hashFile } from "./backup.mjs";
import { encryptBackup, encryptDirectory } from "./backup-encryption.mjs";
import { deployLocal } from "./deploy-local.mjs";
import { assertProductionConfig, readConfig } from "./deployment-config.mjs";
import { ignoredOutput, privateFile, projectRoot } from "./operations-lib.mjs";

export function assertCiContext(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REF !== "refs/heads/main" || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || "") || env.GITHUB_REPOSITORY !== env.FERTO_DEPLOY_REPOSITORY || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || "")) throw new Error("Production CI requires the configured repository, main branch and push/manual event");
}

export async function assertCurrentMain({ env = process.env, fetchImpl = fetch, root = projectRoot } = {}) {
  assertCiContext(env);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (revision !== env.GITHUB_SHA) throw new Error("CI checkout does not match the workflow revision");
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new Error("A read-only GitHub token is needed to reject stale release runs");
  const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/main`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Could not confirm the current main revision"); }
  const body = await response.json();
  if (body.object?.sha !== revision) throw new Error("This release was superseded on main; no new deployment will start");
}

export function instanceConfig(template, instance) {
  const fields = ["accountId", "databaseId", "databaseName", "spotifyClientId", "ownerSpotifyId", "origin"];
  if (fields.some(key => typeof instance[key] !== "string" || !instance[key]) || Object.keys(instance).some(key => !fields.includes(key)) || !/^[a-f0-9]{32}$/i.test(instance.accountId)) throw new Error("CI instance settings are incomplete or include unexpected fields");
  const config = structuredClone(template);
  config.account_id = instance.accountId;
  const db = config.d1_databases.find(binding => binding.binding === "DB");
  db.database_id = instance.databaseId; db.database_name = instance.databaseName;
  config.vars = { SPOTIFY_CLIENT_ID: instance.spotifyClientId, OWNER_SPOTIFY_ID: instance.ownerSpotifyId, APP_ORIGIN: instance.origin };
  return assertProductionConfig(config);
}

export async function targetRelease({ root = projectRoot, instance, recipient } = {}) {
  const check = production => execFileSync(process.execPath, [join(root, "scripts/check-release-artifact.mjs"), ...(production ? ["--production"] : [])], { cwd: root, stdio: "inherit" });
  check(false);
  const template = readConfig(join(root, "wrangler.jsonc"));
  const config = instanceConfig(template, instance);
  await ignoredOutput(join(root, ".local/ci"), root);
  const configFile = join(root, "wrangler.production.jsonc");
  // Never replace an existing operator's private instance file.
  execFileSync("git", ["check-ignore", "--quiet", "--", "wrangler.production.jsonc"], { cwd: root });
  await privateFile(configFile, JSON.stringify(config, null, 2) + "\n");
  if (typeof recipient !== "string" || !recipient.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----")) throw new Error("Configure the backup public recipient key before production CI");
  await privateFile(join(root, ".local/ci/recipient.asc"), recipient);
  const packaged = structuredClone(config);
  packaged.main = "worker/worker.js"; packaged.assets.directory = "./assets";
  packaged.d1_databases.find(binding => binding.binding === "DB").migrations_dir = "migrations";
  const manifestFile = join(root, ".release/manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const text = JSON.stringify(packaged, null, 2) + "\n";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, ".release/wrangler.jsonc"), text, { mode: 0o600 });
  const htmlFile = join(root, ".release/assets/index.html");
  const html = await readFile(htmlFile, "utf8");
  const escape = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const from = `${escape(template.vars.APP_ORIGIN)}/`;
  if (html.split(from).length - 1 !== 4) throw new Error("Expected four reviewed canonical/social metadata URLs before targeting");
  const targetedHtml = html.replaceAll(from, `${escape(config.vars.APP_ORIGIN)}/`);
  manifest.targetedFrom = { configurationSha256: manifest.files["wrangler.jsonc"], homepageSha256: manifest.files["assets/index.html"] };
  await writeFile(htmlFile, targetedHtml, { mode: 0o600 });
  manifest.files["assets/index.html"] = createHash("sha256").update(targetedHtml).digest("hex");
  manifest.files["wrangler.jsonc"] = createHash("sha256").update(text).digest("hex");
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  check(true);
  return configFile;
}

export async function confirmSavedBackup({ root = projectRoot, artifactId = process.env.FERTO_BACKUP_ARTIFACT_ID } = {}) {
  if (!/^\d+$/.test(artifactId || "")) throw new Error("GitHub did not confirm the saved encrypted backup artifact");
  const saved = JSON.parse(await readFile(join(root, ".local/ci/backup.json"), "utf8"));
  const downloaded = join(root, ".local/ci-roundtrip/backup.gpg");
  const info = await lstat(downloaded);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== saved.bytes || await hashFile(downloaded) !== saved.sha256) throw new Error("Downloaded encrypted backup differs from the locally verified export");
  return { ...saved, artifactId };
}

export async function sealRecoveryEvidence({ root = projectRoot } = {}) {
  const evidence = await ignoredOutput(join(root, ".local/ci-evidence"), root);
  let found = false;
  try {
    await cp(join(root, ".local/releases"), join(evidence, "releases"), { recursive: true }); found = true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let backups = [];
  try { backups = await readdir(join(root, "backups/ferto"), { withFileTypes: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const folder of backups.filter(entry => entry.isDirectory())) {
    const source = join(root, "backups/ferto", folder.name);
    for (const file of await readdir(source, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".log")) continue;
      const destination = join(evidence, "backups", folder.name);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await cp(join(source, file.name), join(destination, file.name)); found = true;
    }
  }
  if (!found) return null;
  return encryptDirectory(evidence, { recipientFile: join(root, ".local/ci/recipient.asc"), output: join(root, ".local/ci-logs/operations.gpg"), root });
}

export async function runCi(command) {
  const root = projectRoot;
  if (command === "prepare") {
    await assertCurrentMain();
    let instance;
    try { instance = JSON.parse(process.env.FERTO_INSTANCE_CONFIG || ""); } catch { throw new Error("Configure FERTO_INSTANCE_CONFIG in the production environment"); }
    await targetRelease({ instance, recipient: process.env.FERTO_BACKUP_PUBLIC_KEY });
    console.log("Checked release targeted to the production instance; credentials were not printed.");
  } else if (command === "backup") {
    await assertCurrentMain();
    const result = await createBackup();
    const output = join(root, ".local/ci-upload/backup.gpg");
    await encryptBackup(result.directory, { recipientFile: join(root, ".local/ci/recipient.asc"), output });
    await privateFile(join(root, ".local/ci/backup.json"), JSON.stringify({ directory: result.directory, sha256: await hashFile(output), bytes: (await lstat(output)).size }) + "\n");
    console.log("Full backup restored/verified locally and encrypted; it must be uploaded and downloaded successfully before deployment.");
  } else if (command === "deploy") {
    await assertCurrentMain();
    const saved = await confirmSavedBackup();
    const result = await deployLocal({ backupDirectory: saved.directory, migrate: process.env.FERTO_APPLY_MIGRATIONS === "true" });
    console.log(`CI release ${result.version} verified and Queue resumed. Encrypted backup artifact ${saved.artifactId}.`);
  } else if (command === "logs") {
    if (await sealRecoveryEvidence()) console.log("Operational and backup diagnostic logs encrypted for the local backup key.");
  } else throw new Error("Usage: node scripts/deploy-ci.mjs prepare|backup|deploy|logs");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  runCi(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
